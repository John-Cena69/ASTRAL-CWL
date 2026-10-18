// POST /api/sync — runs both fillers + wars in one call (used by the
// scheduled job and the manual Sync buttons).
// Auth: CRON_SECRET header or allowlisted user JWT.
import { authorize } from './_lib/backend.js';
import { syncFillers } from './sync-fillers.js';
import { syncWars } from './sync-wars.js';

export default async function handler(req: unknown, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): Promise<void> {
  const r = req as { method?: string; headers: Record<string, string | string[] | undefined> };
  if (r.method !== 'POST' && r.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Use POST.' });
    return;
  }
  const auth = await authorize(r);
  if (auth.ok === false) {
    res.status(401).json({ ok: false, error: auth.message });
    return;
  }
  try {
    const [fillers, wars] = await Promise.all([syncFillers(), syncWars()]);
    res.status(200).json({ ok: true, fillers, wars, syncedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Sync failed.',
    });
  }
}
