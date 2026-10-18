// GET /api/tracked-clans — list all tracked clans from family_clans (sidebar categories)
// POST /api/tracked-clans — add a clan (Developer only)
// DELETE /api/tracked-clans?clan_tag=#TAG — remove a clan (Developer only)
import { adminClient, authorize, type AuthResult, readJsonBody } from './_lib/backend.js';

export default async function handler(req: unknown, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): Promise<void> {
  const r = req as {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    query?: Record<string, string | string[] | undefined>;
    body?: unknown;
  };
  const auth = await authorize(r);
  if (auth.ok === false) {
    res.status(401).json({ ok: false, error: auth.message });
    return;
  }

  const isDeveloper = auth.role === 'Developer';

  if (r.method === 'GET') {
    try {
      const supabase = adminClient();
      const { data, error } = await supabase
        .from('family_clans')
        .select('clan_tag, clan_name, added_date')
        .order('added_date', { ascending: true });
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, clans: data ?? [] });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Failed to load clans.' });
    }
    return;
  }

  // POST and DELETE require Developer role
  if (!isDeveloper) {
    res.status(403).json({ ok: false, error: 'Developer role required.' });
    return;
  }

  if (r.method === 'POST') {
    const body = readJsonBody(r);
    const clanTag = String(body.clan_tag ?? '').trim().toUpperCase().replace(/^#+/, '');
    const clanName = String(body.clan_name ?? '').trim();
    if (!clanTag || !clanName) {
      res.status(400).json({ ok: false, error: 'Clan tag and name are required.' });
      return;
    }
    const tag = `#${clanTag}`;
    try {
      const supabase = adminClient();
      const { error } = await supabase
        .from('family_clans')
        .upsert({ clan_tag: tag, clan_name: clanName }, { onConflict: 'clan_tag' });
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, clan_tag: tag, clan_name: clanName });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Add failed.' });
    }
    return;
  }

  if (r.method === 'DELETE') {
    const clanTag = String(r.query?.clan_tag ?? '').trim().toUpperCase().replace(/^#+/, '');
    if (!clanTag) {
      res.status(400).json({ ok: false, error: 'Clan tag is required.' });
      return;
    }
    const tag = `#${clanTag}`;
    try {
      const supabase = adminClient();
      const { error } = await supabase.from('family_clans').delete().eq('clan_tag', tag);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, deleted: tag });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Delete failed.' });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Use GET, POST, or DELETE.' });
}
