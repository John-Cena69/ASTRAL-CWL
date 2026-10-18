// GET /api/war-weights?clan_tag=#TAG — returns cached war weight data for a clan
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
      .from('war_weights')
      .select('player_name, player_tag, town_hall, war_weight, map_position, updated_date')
      .eq('clan_tag', tag)
      .order('map_position', { ascending: true });
    if (error) throw new Error(error.message);
    res.status(200).json({ ok: true, clan_tag: tag, weights: data ?? [] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Failed to load war weights.' });
  }
}
