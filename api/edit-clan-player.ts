// POST /api/edit-clan-player — update a roster player's tag, role, or join date
// Recalculates days_in_clan from join_date.
import { adminClient, authorize } from './_lib/backend.js';

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
    ? r.body as {
        clan_tag?: string;
        player_tag?: string;
        new_player_tag?: string;
        role?: string;
        join_date?: string;
      }
    : {};

  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const playerTagRaw = String(body.player_tag ?? '').trim();
  if (!clanTagRaw || !playerTagRaw) {
    res.status(400).json({ ok: false, error: 'Clan tag and player tag are required.' });
    return;
  }

  const clanTag = `#${clanTagRaw.toUpperCase().replace(/^#+/, '')}`;
  const playerTag = `#${playerTagRaw.toUpperCase().replace(/^#+/, '')}`;

  const updates: Record<string, unknown> = {};
  const newPlayerTag = body.new_player_tag
    ? `#${String(body.new_player_tag).trim().toUpperCase().replace(/^#+/, '')}`
    : null;

  if (newPlayerTag) updates.player_tag = newPlayerTag;
  if (body.role) updates.role = body.role;
  if (body.join_date) updates.join_date = body.join_date;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ ok: false, error: 'Nothing to update.' });
    return;
  }

  try {
    const supabase = adminClient();

    // Recalculate days_in_clan if join_date changed
    if (body.join_date) {
      const now = new Date();
      const oneDayMs = 24 * 60 * 60 * 1000;
      const joinTime = new Date(body.join_date).getTime();
      updates.days_in_clan = Math.floor((now.getTime() - joinTime) / oneDayMs);
    }

    updates.updated_date = new Date().toISOString();

    const targetTag = newPlayerTag ?? playerTag;
    const { error, data } = await supabase
      .from('clan_players')
      .update(updates)
      .eq('clan_tag', clanTag)
      .eq('player_tag', playerTag)
      .select();

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      res.status(404).json({ ok: false, error: 'Player not found in this clan.' });
      return;
    }

    res.status(200).json({ ok: true, updated: data[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Update failed.' });
  }
}
