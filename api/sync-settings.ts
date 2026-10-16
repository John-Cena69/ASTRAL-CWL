// POST /api/sync-settings — privileged bot_settings writes for allowlisted
// users. Uses the service-role client so it works regardless of the table's
// row-security policies. Auth: CRON_SECRET header or allowlisted user JWT.
// Body: { "setting_key": "fwa_sync_state", "setting_value": "High" }
import { adminClient, authorize, readJsonBody } from './_lib/backend.js';

const ALLOWED_VALUES: Record<string, string[]> = {
  fwa_sync_state: ['Low', 'High'],
};

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

  const body = readJsonBody(r);
  const settingKey = String(body.setting_key ?? '');
  const settingValue = String(body.setting_value ?? '');
  if (!ALLOWED_VALUES[settingKey]?.includes(settingValue)) {
    res.status(400).json({ ok: false, error: 'Unsupported setting or value.' });
    return;
  }

  try {
    const { error } = await adminClient()
      .from('bot_settings')
      .update({ setting_value: settingValue })
      .eq('setting_key', settingKey);
    if (error) throw new Error(error.message);
    res.status(200).json({ ok: true, setting_key: settingKey, setting_value: settingValue });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Save failed.',
    });
  }
}
