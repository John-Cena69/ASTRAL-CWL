// POST /api/edit-war-weight — update a war weight row's VALUE
// Recalculates WAR WEIGHT = VALUE * 5.
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
    ? r.body as {
        clan_tag?: string;
        player_tag?: string;
        value?: number;
      }
    : {};

  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const playerTagRaw = String(body.player_tag ?? '').trim();
  const value = body.value ?? null;

  if (!clanTagRaw || !playerTagRaw) {
    res.status(400).json({ ok: false, error: 'Clan tag and player tag are required.' });
    return;
  }
  if (value === null || value === undefined || !Number.isInteger(value) || value < 0) {
    res.status(400).json({ ok: false, error: 'Value must be a whole number of 0 or greater.' });
    return;
  }

  const clanTag = `#${clanTagRaw.toUpperCase().replace(/^#+/, '')}`;
  const playerTag = `#${playerTagRaw.toUpperCase().replace(/^#+/, '')}`;

  try {
    const supabase = adminClient();

    const { error, data } = await supabase
      .from('war_weights')
      .update({
        value,
        war_weight: value * 5,
        updated_date: new Date().toISOString(),
      })
      .eq('clan_tag', clanTag)
      .eq('player_tag', playerTag)
      .select();

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      res.status(404).json({ ok: false, error: 'Player not found in war weights.' });
      return;
    }

    res.status(200).json({ ok: true, updated: data[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Update failed.' });
  }
}
