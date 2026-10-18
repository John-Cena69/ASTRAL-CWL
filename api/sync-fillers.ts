// POST /api/sync-fillers — replaces the bot's update_fillers loop.
// Refreshes player_name / town_hall / clan_tag / clan_name for every row
// in filler_accounts. Auth: CRON_SECRET header or allowlisted user JWT.
import { CocMaintenance, getPlayer } from './_lib/coc.js';
import { adminClient, authorize } from './_lib/backend.js';

async function run(): Promise<{
  updated: number;
  missing: number;
  errors: string[];
}> {
  const supabase = adminClient();
  const { data, error } = await supabase.from('filler_accounts').select('player_tag');
  if (error) throw new Error(error.message);
  const tags = (data ?? []).map((row) => row.player_tag as string);
  if (tags.length === 0) return { updated: 0, missing: 0, errors: [] };

  let updated = 0;
  let missing = 0;
  const errors: string[] = [];
  const CONCURRENCY = 8;

  for (let i = 0; i < tags.length; i += CONCURRENCY) {
    const batch = tags.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (tag) => {
        const player = await getPlayer(tag);
        const { error: updateError } = await supabase
          .from('filler_accounts')
          .update({
            player_name: player.name,
            town_hall: player.townHallLevel,
            clan_tag: player.clan?.tag ?? null,
            clan_name: player.clan?.name ?? null,
          })
          .eq('player_tag', player.tag);
        if (updateError) throw new Error(`${tag}: ${updateError.message}`);
      })
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled') {
        updated++;
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        if (message.includes('404') || message.includes('Not found')) missing++;
        else if (errors.length < 10) errors.push(`${batch[j]}: ${message.slice(0, 160)}`);
        else errors.push(`${batch[j]}: ${message.slice(0, 80)}`);
      }
    }
  }
  return { updated, missing, errors: errors.slice(0, 10) };
}

export async function syncFillers(): Promise<{
  updated: number;
  missing: number;
  errors: string[];
}> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CocMaintenance) {
      return { updated: 0, missing: 0, errors: ['CoC API in maintenance, skipped.'] };
    }
    throw error;
  }
}

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
    const result = await syncFillers();
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Sync failed.',
    });
  }
}
