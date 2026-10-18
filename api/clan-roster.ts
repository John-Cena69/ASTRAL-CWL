// GET /api/clan-roster?clan_tag=#TAG — returns roster data for a clan's Home page
// Joins clan_players with war_weights to surface War Weight.
import { adminClient, authorize } from './_lib/backend.js';

export default async function handler(req: unknown, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): Promise<void> {
  const r = req as {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    query?: Record<string, string | string[] | undefined>;
  };
  const auth = await authorize(r);
  if (auth.ok === false) {
    res.status(401).json({ ok: false, error: auth.message });
    return;
  }

  if (r.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Use GET.' });
    return;
  }

  const clanTag = String(r.query?.clan_tag ?? '').trim().toUpperCase().replace(/^#+/, '');
  if (!clanTag) {
    res.status(400).json({ ok: false, error: 'Clan tag is required.' });
    return;
  }

  const tag = `#${clanTag}`;
  try {
    const supabase = adminClient();
    const { data, error } = await supabase
      .from('clan_players')
      .select(`
        id, player_name, player_tag, discord_id, town_hall, role, status,
        join_date, days_in_clan, war_weight, updated_date
      `)
      .eq('clan_tag', tag)
      .order('war_weight', { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);
    res.status(200).json({ ok: true, clan_tag: tag, players: data ?? [] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Failed to load roster.' });
  }
}
