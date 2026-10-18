// POST /api/add-clan-player — add a player to a clan roster with auto-sync
// Fetches player from CoC API, looks up Discord ID from playerbase, inserts into clan_players.
import { getPlayer } from './_lib/coc.js';
import { adminClient, authorize } from './_lib/backend.js';

function cocRoleToWebsiteRole(role: string): string {
  const r = role.toLowerCase();
  if (r === 'leader') return 'Leader';
  if (r === 'coleader') return 'Co-Leader';
  if (r === 'elder') return 'Elder';
  return 'Member';
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
    ? r.body as { clan_tag?: string; player_tag?: string }
    : {};
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const playerTagRaw = String(body.player_tag ?? '').trim();
  if (!clanTagRaw || !playerTagRaw) {
    res.status(400).json({ ok: false, error: 'Clan tag and player tag are required.' });
    return;
  }
  const cleanClan = clanTagRaw.toUpperCase().replace(/^#+/, '');
  const cleanPlayer = playerTagRaw.toUpperCase().replace(/^#+/, '');
  if (!/^[0289CGJLPUVQRY]+$/.test(cleanClan) || cleanClan.length < 3) {
    res.status(400).json({ ok: false, error: 'Invalid clan tag.' });
    return;
  }
  if (!/^[0289CGJLPUVQRY]+$/.test(cleanPlayer) || cleanPlayer.length < 3) {
    res.status(400).json({ ok: false, error: 'Invalid player tag.' });
    return;
  }
  const clanTag = `#${cleanClan}`;
  const playerTag = `#${cleanPlayer}`;

  try {
    const supabase = adminClient();

    // Fetch player from CoC API
    let player;
    try {
      player = await getPlayer(playerTag);
    } catch (error) {
      res.status(404).json({ ok: false, error: `Player ${playerTag} not found in CoC API.` });
      return;
    }

    // Look up Discord ID from playerbase
    let discordId: string | null = null;
    try {
      const { data: linked, error: linkedError } = await supabase
        .from('playerbase')
        .select('discord_id')
        .eq('player_tag', playerTag)
        .maybeSingle();
      if (!linkedError && linked) {
        discordId = linked.discord_id ?? null;
      }
    } catch {
      // Ignore playerbase errors
    }

    const role = cocRoleToWebsiteRole(player.role ?? 'member');
    const now = new Date().toISOString();

    const { error, data } = await supabase
      .from('clan_players')
      .insert({
        clan_tag: clanTag,
        player_name: player.name,
        player_tag: player.tag,
        discord_id: discordId,
        town_hall: player.townHallLevel ?? null,
        role,
        status: 'All good',
        join_date: now,
        days_in_clan: 0,
        war_weight: null,
        updated_date: now,
      })
      .select();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ ok: false, error: 'Player already exists in this clan roster.' });
        return;
      }
      throw new Error(error.message);
    }

    res.status(200).json({ ok: true, added: data?.[0] ?? null });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Add player failed.' });
  }
}
