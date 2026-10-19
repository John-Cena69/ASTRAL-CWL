import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

export function adminClient(): SupabaseClient {
  if (!URL || !SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server env, never VITE_).');
  }
  return createClient(URL, SERVICE_KEY);
}

/**
 * Allows the request when it carries the cron secret, otherwise requires a
 * Supabase JWT belonging to a Discord user on the allowlist
 * (same get_my_allowed_role check as the frontend).
 */
export type AuthResult =
  | { ok: true; role?: string }
  | { ok: false; message: string };

/**
 * Allows the request when it carries the cron secret, otherwise requires a
 * Supabase JWT belonging to a Discord user on the allowlist
 * (same get_my_allowed_role check as the frontend).
 * Returns the user's role when available.
 */
export async function authorize(req: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<AuthResult> {
  const cronSecret = process.env.CRON_SECRET || '';
  const header = (name: string): string => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] ?? '' : value ?? '';
  };

  const supplied = header('x-cron-secret');
  if (cronSecret && supplied && supplied === cronSecret) return { ok: true, role: 'Developer' };

  const authHeader = header('authorization');
  const token =
    authHeader.startsWith('Bearer ') && authHeader.slice(7) !== cronSecret
      ? authHeader.slice(7)
      : '';
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return { ok: true, role: 'Developer' };
  if (!token) return { ok: false, message: 'Unauthorized.' };
  if (!URL || !ANON_KEY) return { ok: false, message: 'Server Supabase env missing.' };

  const client = createClient(URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.rpc('get_my_allowed_role');
  if (error || !data) {
    return { ok: false, message: 'Forbidden: your Discord account is not allowlisted.' };
  }
  return { ok: true, role: typeof data === 'string' ? data : undefined };
}

export function json(data: unknown, status = 200): { statusCode: number; body: string } {
  return { statusCode: status, body: JSON.stringify(data) };
}

export function readJsonBody(req: { body?: unknown }): Record<string, unknown> {
  const body = (req as { body?: unknown }).body;
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return body as Record<string, unknown>;
}

/* ───────────────────── second Supabase project (linked_players) ───────────────────── */

const PLAYERBASE_URL = process.env.PLAYERBASE_SUPABASE_URL || '';
const PLAYERBASE_SERVICE_KEY = process.env.PLAYERBASE_SUPABASE_SERVICE_ROLE_KEY || '';

export function playerbaseAdminClient(): SupabaseClient {
  if (!PLAYERBASE_URL || !PLAYERBASE_SERVICE_KEY) {
    throw new Error(
      'PLAYERBASE_SUPABASE_URL and PLAYERBASE_SUPABASE_SERVICE_ROLE_KEY must be set (server env, never VITE_).'
    );
  }
  return createClient(PLAYERBASE_URL, PLAYERBASE_SERVICE_KEY);
}
