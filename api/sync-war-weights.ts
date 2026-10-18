// POST /api/sync-war-weights — manually sync war weights for one clan (no loops)
// Fetches the current war from CoC API, sorts roster by map position,
// upserts into war_weights. Defaults VALUE = Town Hall so WAR WEIGHT = VALUE * 5.
import { getCurrentWar } from './_lib/coc.js';
import { adminClient, authorize } from './_lib/backend.js';

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

    let war;
    try {
      war = await getCurrentWar(clanTag);
    } catch (error) {
      res.status(404).json({ ok: false, error: `No current war found for ${clanTag}.` });
      return;
    }

    if (!war) {
      res.status(404).json({ ok: false, error: `The clan is not currently in a war.` });
      return;
    }

    const roster = [...(war.clan as { name: string; tag: string; map_position?: number; town_hall?: number }[])]
      .sort((a, b) => (a.map_position ?? 999) - (b.map_position ?? 999));

    if (roster.length === 0) {
      res.status(200).json({ ok: true, updated: 0, message: 'No roster members in war.' });
      return;
    }

    const now = new Date().toISOString();
    const upserts = roster.map((member, index) => {
      const th = member.town_hall ?? 0;
      const value = th; // default VALUE = Town Hall
      return {
        clan_tag: clanTag,
        player_name: member.name,
        player_tag: member.tag,
        town_hall: th,
        value,
        war_weight: value * 5,
        map_position: index + 1,
        updated_date: now,
      };
    });

    const CHUNK = 50;
    let updated = 0;
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const chunk = upserts.slice(i, i + CHUNK);
      const { error } = await supabase
        .from('war_weights')
        .upsert(chunk, { onConflict: 'clan_tag, player_tag' });
      if (error) throw new Error(error.message);
      updated += chunk.length;
    }

    res.status(200).json({
      ok: true,
      updated,
      clan_tag: clanTag,
      state: war.state,
      message: `Synced ${updated} war weights for ${clanTag}`,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Sync failed.' });
  }
}
