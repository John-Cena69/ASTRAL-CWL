// Local auto-sync loop (replaces the bot's @tasks.loop(minutes=2)).
// Calls POST /api/sync every SYNC_INTERVAL_MS against a local
// `vercel dev` server (or any URL via SYNC_URL).
// Usage:  npm run sync:loop            (every 2 min, runs forever)
//         node scripts/sync-loop.mjs --once   (single run, then exit)
import { readFileSync, existsSync } from 'node:fs';

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    let value = trimmed.slice(trimmed.indexOf('=') + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

const SYNC_URL = (process.env.SYNC_URL || 'http://localhost:3000').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET || '';
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 2 * 60 * 1000);

async function runOnce() {
  const started = Date.now();
  try {
    const response = await fetch(`${SYNC_URL}/api/sync`, {
      method: 'POST',
      headers: { 'x-cron-secret': CRON_SECRET },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    const wars = body.wars ?? {};
    const fillers = body.fillers ?? {};
    console.log(
      `[${new Date().toLocaleTimeString()}] ok (${Date.now() - started}ms): ` +
        `wars upserted=${wars.upserted ?? '?'} checked=${wars.checked ?? '?'} skipped=${wars.skipped ?? '?'}${wars.skipDetail ? ` (${wars.skipDetail})` : ''}, ` +
        `fillers updated=${fillers.updated ?? '?'}${wars.syncFlipped ? ' SYNC-FLIPPED' : ''}` +
        `${(wars.errors ?? []).length || (fillers.errors ?? []).length ? ` errors=${JSON.stringify([...(wars.errors ?? []), ...(fillers.errors ?? [])]).slice(0, 300)}` : ''}`
    );
  } catch (error) {
    console.log(
      `[${new Date().toLocaleTimeString()}] FAILED: ${error instanceof Error ? error.message : error}`
    );
  }
}

if (process.argv.includes('--once')) {
  await runOnce();
} else {
  console.log(`Sync loop -> ${SYNC_URL}/api/sync every ${INTERVAL_MS / 1000}s. Ctrl+C to stop.`);
  await runOnce();
  setInterval(runOnce, INTERVAL_MS);
}
