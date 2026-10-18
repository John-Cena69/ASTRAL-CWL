// POST /api/sync-clan-roster — manually sync roster for one clan (no loops)
// Fetches clan members from CoC API, cross-references Discord IDs from linked_players,
// computes role + status, and upserts into clan_players.
import { getClan } from './_lib/coc.js';
import { adminClient, authorize } from './_lib/backend.js';

function cocRoleToWebsiteRole(role: string): string {
  const r = role.toLowerCase();
  if (r === 'leader') return 'Leader';
  if (r === 'coleader') return 'Co-Leader';
  if (r === 'elder') return 'Elder';
  return 'Member';
}

function normalizeRoleForComparison(role: string): string {
  const r = role.toLowerCase().trim();
  if (r === 'leader') return 'leader';
  if (r === 'co-leader' || r === 'coleader' || r === 'rep') return 'coleader';
  if (r === 'elder' || r === 'staff' || r === 'admin') return 'elder';
  if (r === 'member') return 'member';
  if (r === 'filler') return 'filler';
  return r;
}

export default async function handler(req: unknown, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): Promise<void> {
  const r = req as {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
  };
  if (r.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST.' });
    return;
  }
  const auth = await authorize(r);
  if (auth.ok === false) {
    res.status(401).json({ ok: false, error: auth.message });
    return;
  }

  const body = (r.body && typeof r.body === 'object' && r.body !== null)
    ? r.body as { clan_tag?: string }
    : {};
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  if (!clanTagRaw) {
    res.status(400).json({ ok: false, error: 'Clan tag is required.' });
    return;
  }
  const clean = clanTagRaw.toUpperCase().replace(/^#+/, '');
  if (!/^[0289CGJLPUVQRY]+$/.test(clean) || clean.length < 3) {
    res.status(400).json({ ok: false, error: 'Invalid clan tag.' });
    return;
  }
  const clanTag = `#${clean}`;

  try {
    const supabase = adminClient();

    // Fetch clan from CoC API
    let clan;
    try {
      clan = await getClan(clanTag);
    } catch (error) {
      res.status(404).json({ ok: false, error: `Clan ${clanTag} not found in CoC API.` });
      return;
    }

    const members = clan.memberList ?? [];
    if (members.length === 0) {
      res.status(200).json({ ok: true, updated: 0, message: 'No members found.' });
      return;
    }

    // Bulk fetch Discord IDs from playerbase
    const tags = members.map((m) => m.tag);
    const discordIdMap: Record<string, string> = {};
    try {
      const { data: linked, error: linkedError } = await supabase
        .from('playerbase')
        .select('player_tag, discord_id')
        .in('player_tag', tags);
      if (!linkedError && linked) {
        for (const item of linked) {
          discordIdMap[item.player_tag] = item.discord_id ?? '';
        }
      }
    } catch {
      // Ignore linked_players errors, continue without Discord IDs
    }

    // Load existing roster to preserve join_date and detect role changes
    const { data: existing } = await supabase
      .from('clan_players')
      .select('player_tag, role, join_date')
      .eq('clan_tag', clanTag);
    const existingByTag = new Map<string, { role: string; join_date: string | null }>();
    if (existing) {
      for (const row of existing) {
        existingByTag.set(row.player_tag, { role: row.role, join_date: row.join_date });
      }
    }

    const now = new Date();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const upserts = members.map((member) => {
      const existingRow = existingByTag.get(member.tag);
      const igRole = cocRoleToWebsiteRole(member.role);
      const previousRole = existingRow?.role ?? '';
      const previousJoinDate = existingRow?.join_date ?? null;

      // Determine join_date: keep original if exists, otherwise now
      const joinDate = previousJoinDate ?? now.toISOString();

      // Compute days in clan
      const joinTime = new Date(joinDate).getTime();
      const daysInClan = previousJoinDate
        ? Math.floor((now.getTime() - joinTime) / oneDayMs)
        : 0;

      // Determine status
      let status: string;
      const normalizedPrevious = normalizeRoleForComparison(previousRole);
      const normalizedIg = normalizeRoleForComparison(member.role);

      if (normalizedIg === 'filler') {
        status = 'All good';
      } else if (previousRole && normalizedPrevious !== '' && normalizedPrevious !== normalizedIg) {
        status = 'Role Mismatch';
      } else {
        status = 'All good';
      }

      return {
        clan_tag: clanTag,
        player_name: member.name,
        player_tag: member.tag,
        discord_id: discordIdMap[member.tag] ?? null,
        town_hall: member.town_hall ?? null,
        role: igRole,
        status,
        join_date: joinDate,
        days_in_clan,
        war_weight: null,
        updated_date: now.toISOString(),
      };
    });

    // Upsert in chunks
    const CHUNK = 50;
    let updated = 0;
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const chunk = upserts.slice(i, i + CHUNK);
      const { error } = await supabase
        .from('clan_players')
        .upsert(chunk, { onConflict: 'clan_tag, player_tag' });
      if (error) throw new Error(error.message);
      updated += chunk.length;
    }

    res.status(200).json({ ok: true, updated, clan_tag: clanTag, clan_name: clan.name });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Sync failed.' });
  }
}
