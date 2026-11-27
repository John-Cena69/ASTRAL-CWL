// api/[...slug].ts — Single catch-all serverless function
// Replaces 13 individual API files to stay under Vercel Hobby's 12-function limit.
// All frontend fetch URLs stay exactly the same.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  CocMaintenance,
  CocNotFound,
  PrivateWarLog,
  getClan,
  getCurrentWar,
  getPlayer,
  getPlayerProfile,
  toUnixSeconds,
} from './_lib/coc.js';
import { calculateFwaResult, getFwaPoints, lookupPoints } from './_lib/fwa.js';
import { playerbaseAdminClient } from './_lib/backend.js';

/* ───────────────────── config & audit context ───────────────────── */

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

interface AuditContext {
  requestId: string;
  action: string;
  skip: boolean;
  revertOf?: number;
  discordId?: string;
  name?: string;
  username?: string;
  role?: string;
  avatarUrl?: string;
}

const auditStorage = new AsyncLocalStorage<AuditContext>();

function b64(value?: string): string {
  return value ? Buffer.from(value, 'utf8').toString('base64') : '';
}

function buildAuditHeaders(extra?: { skip?: boolean; revertOf?: number; action?: string }): Record<string, string> {
  const ctx = auditStorage.getStore();
  if (!ctx) return {};
  if (extra?.skip ?? ctx.skip) return { 'x-audit-skip': '1' };
  const headers: Record<string, string> = {
    'x-audit-request-id': ctx.requestId,
    'x-audit-action': extra?.action || ctx.action,
  };
  if (ctx.discordId) headers['x-audit-actor-id'] = ctx.discordId;
  if (ctx.name) headers['x-audit-actor-name'] = b64(ctx.name);
  if (ctx.username) headers['x-audit-actor-username'] = b64(ctx.username);
  if (ctx.role) headers['x-audit-actor-role'] = ctx.role;
  if (ctx.avatarUrl) headers['x-audit-actor-avatar'] = ctx.avatarUrl;
  const revertOf = extra?.revertOf ?? ctx.revertOf;
  if (revertOf) headers['x-audit-revert-of'] = String(revertOf);
  return headers;
}

function recordAuditSummaryEntry(params: {
  table_name: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  clan_tag?: string | null;
  action?: string;
  new_data?: Record<string, unknown> | null;
  old_data?: Record<string, unknown> | null;
  changed_fields?: string[];
}): PromiseLike<unknown> {
  const ctx = auditStorage.getStore();
  if (ctx?.skip) return Promise.resolve();
  const raw = rawAdminClient();
  return raw.from('audit_log').insert({
    table_name: params.table_name,
    operation: params.operation,
    row_pk: null,
    old_data: params.old_data ?? null,
    new_data: params.new_data ?? null,
    changed_fields: params.changed_fields ?? [],
    clan_tag: params.clan_tag ?? null,
    actor_discord_id: ctx?.discordId ?? null,
    actor_name: ctx?.name ?? null,
    actor_username: ctx?.username ?? null,
    actor_role: ctx?.role ?? null,
    actor_avatar_url: ctx?.avatarUrl ?? null,
    source: 'website',
    action: params.action ?? ctx?.action ?? null,
    request_id: ctx?.requestId ?? null,
  });
}

function rawAdminClient(headers?: Record<string, string>): SupabaseClient {
  const missing: string[] = [];
  if (!URL) missing.push('SUPABASE_URL');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    throw new Error(`Missing server env vars: ${missing.join(', ')}. Set them in Vercel Project Settings → Environment Variables.`);
  }
  return createClient(URL, SERVICE_KEY, headers && Object.keys(headers).length > 0 ? { global: { headers } } : undefined);
}

function adminClient(extra?: { skip?: boolean; revertOf?: number; action?: string }): SupabaseClient {
  return rawAdminClient(buildAuditHeaders(extra));
}

/* ───────────────────── auth ───────────────────── */

interface AuthUserSummary {
  discordId?: string;
  name?: string;
  username?: string;
  avatarUrl?: string;
}

type AuthResult =
  | { ok: true; role?: string; isCron?: boolean; user?: AuthUserSummary }
  | { ok: false; message: string };

const discordNickCache = new Map<string, { name: string; username: string; avatarUrl: string | null; at: number }>();

function getHeader(req: { url: string; headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

async function resolveAuthUser(token: string): Promise<AuthUserSummary> {
  try {
    const { data } = await rawAdminClient().auth.getUser(token);
    const u = data?.user;
    if (!u) return {};
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    const identity = u.identities?.find((id) => id.provider === 'discord');
    const idData = (identity?.identity_data ?? {}) as Record<string, unknown>;
    const claims = (meta.custom_claims ?? idData.custom_claims ?? {}) as Record<string, unknown>;
    const clean = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/#0$/, '') : '');
    const discordId = String(
      meta.provider_id ?? identity?.id ?? idData.provider_id ?? idData.sub ?? meta.sub ?? ''
    ).trim();
    let username = clean(meta.user_name || idData.username || meta.name);
    let name =
      clean(meta.discord_nickname) ||
      clean(claims.global_name) ||
      clean(meta.full_name) ||
      clean(idData.full_name) ||
      username;
    let avatarUrl =
      (typeof meta.avatar_url === 'string' && meta.avatar_url.trim()) ||
      (typeof idData.avatar_url === 'string' && idData.avatar_url.trim()) ||
      undefined;

    if (discordId && /^\d{15,22}$/.test(discordId)) {
      const cached = discordNickCache.get(discordId);
      if (cached && Date.now() - cached.at < 15 * 60 * 1000) {
        name = cached.name || name;
        username = cached.username || username;
        avatarUrl = cached.avatarUrl || avatarUrl;
      } else if (process.env.DISCORD_BOT_TOKEN) {
        try {
          const live = await lookupDiscordProfile(discordId);
          if (live.nickname && live.nickname !== discordId) name = live.nickname;
          if (live.username && live.username !== discordId) username = live.username;
          if (live.avatar_url) avatarUrl = live.avatar_url;
          discordNickCache.set(discordId, {
            name: name || discordId,
            username: username || discordId,
            avatarUrl: avatarUrl ?? null,
            at: Date.now(),
          });
        } catch {
          // fall back to OAuth metadata
        }
      }
    }
    return {
      discordId: discordId || undefined,
      name: name || username || u.email || u.id,
      username: username || undefined,
      avatarUrl,
    };
  } catch {
    return {};
  }
}

async function authorize(req: { url: string; headers: Record<string, string | string[] | undefined> }): Promise<AuthResult> {
  const supplied = getHeader(req, 'x-cron-secret');
  if (CRON_SECRET && supplied && supplied === CRON_SECRET) return { ok: true, role: 'Developer', isCron: true };

  const authHeader = getHeader(req, 'authorization');
  const token =
    authHeader.startsWith('Bearer ') && authHeader.slice(7) !== CRON_SECRET
      ? authHeader.slice(7)
      : '';
  if (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) return { ok: true, role: 'Developer', isCron: true };
  if (!token) return { ok: false, message: 'Unauthorized.' };
  if (!URL || !ANON_KEY) return { ok: false, message: 'Server Supabase env missing.' };

  const client = createClient(URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.rpc('get_my_allowed_role');
  if (error || !data) {
    return { ok: false, message: 'Forbidden: your Discord account is not allowlisted.' };
  }
  const isRead = !(req as { method?: string }).method || (req as { method?: string }).method === 'GET' || (req as { method?: string }).method === 'HEAD';
  const user = isRead ? undefined : await resolveAuthUser(token);
  return { ok: true, role: typeof data === 'string' ? data : undefined, user };
}

function isDeveloper(auth: AuthResult): boolean {
  return auth.ok === true && auth.role === 'Developer';
}

function isManagement(auth: AuthResult): boolean {
  return auth.ok === true && ['Developer', 'Admin'].includes(auth.role ?? '');
}

type AccessLevel = 'none' | 'view' | 'edit';
type PageKey = 'cwl' | 'fillers' | 'wars' | 'clan_management' | 'clan_access' | 'roster' | 'clans' | 'accounts' | 'clan_home' | 'war_weights' | 'strike_board' | 'strike_manager' | 'user_management' | 'audit_log';

async function getClanPageAccessLevel(
  req: { url: string; headers: Record<string, string | string[] | undefined> },
  clanTag: string,
  pageKey: PageKey
): Promise<AccessLevel> {
  const authHeader = getHeader(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !URL || !ANON_KEY) return 'none';
  const client = createClient(URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.rpc('get_clan_page_access_level', {
    requested_clan_tag: clanTag,
    requested_page_key: pageKey,
  });
  if (!error && (data === 'none' || data === 'view' || data === 'edit')) {
    return data;
  }
  const fallback = await client.rpc('can_access_clan_page', {
    requested_clan_tag: clanTag,
    requested_page_key: pageKey,
  });
  return !fallback.error && fallback.data === true ? 'edit' : 'none';
}

async function canAccessClanPage(
  req: { url: string; headers: Record<string, string | string[] | undefined> },
  clanTag: string,
  pageKey: PageKey
): Promise<boolean> {
  return (await getClanPageAccessLevel(req, clanTag, pageKey)) !== 'none';
}

async function canEditClanPage(
  req: { url: string; headers: Record<string, string | string[] | undefined> },
  clanTag: string,
  pageKey: PageKey
): Promise<boolean> {
  return (await getClanPageAccessLevel(req, clanTag, pageKey)) === 'edit';
}
/* ───────────────────── body helpers ───────────────────── */

function readJsonBody(req: { body?: unknown }): Record<string, unknown> {
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

function getQuery(req: { url: string; query?: Record<string, string | string[] | undefined> }): Record<string, string> {
  const params: Record<string, string> = {};

  // Try req.query first (Vercel provides parsed query params)
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') {
        params[k] = v;
      } else if (Array.isArray(v) && v.length > 0) {
        params[k] = v[0];
      }
    }
  }

  // Also try parsing from URL as fallback
  try {
    const urlString = typeof req.url === 'string' ? req.url : '';
    const url = new (URL as any)(urlString, 'http://localhost');
    url.searchParams.forEach((v: string, k: string) => {
      if (!params[k]) params[k] = v;
    });
  } catch {
    // The request URL may be unavailable in some serverless runtimes.
  }

  return params;
}

/* ───────────────────── response helper ───────────────────── */

function send(res: { status: (code: number) => { json: (body: unknown) => void } }, code: number, body: unknown): void {
  res.status(code).json(body);
}

/* ───────────────────── tag helpers ───────────────────── */

// Resolve the exact clan_tag format stored in family_clans (with or without #)
// Auto-creates the clan in family_clans if not found, ensuring FK safety
async function resolveClanTag(supabase: SupabaseClient, inputTag: string): Promise<string> {
  const trimmed = inputTag.trim().toUpperCase();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  const withoutHash = trimmed.replace(/^#+/, '');
  // Try exact match first (both formats)
  const { data: a } = await supabase.from('family_clans').select('clan_tag').eq('clan_tag', withHash).maybeSingle();
  if (a?.clan_tag) return a.clan_tag;
  const { data: b } = await supabase.from('family_clans').select('clan_tag').eq('clan_tag', withoutHash).maybeSingle();
  if (b?.clan_tag) return b.clan_tag;
  // Auto-create the clan in family_clans so FK constraints are satisfied
  const { error: insertError } = await supabase
    .from('family_clans')
    .insert({ clan_tag: withHash, clan_name: withHash });
  if (insertError) throw new Error(insertError.message);
  return withHash;
}

async function ensureClanParent(supabase: SupabaseClient, clanTag: string): Promise<string> {
  const { data: existing, error: selectError } = await supabase
    .from('family_clans')
    .select('clan_tag')
    .eq('clan_tag', clanTag)
    .maybeSingle();
  if (selectError) throw new Error(`Could not verify clan ${clanTag}: ${selectError.message}`);
  if (existing?.clan_tag) return existing.clan_tag;

  const { data: parent, error: insertError } = await supabase
    .from('family_clans')
    .insert({ clan_tag: clanTag, clan_name: clanTag })
    .select('clan_tag')
    .single();
  if (insertError) throw new Error(`Could not create clan ${clanTag}: ${insertError.message}`);
  if (!parent?.clan_tag) {
    throw new Error(`Clan ${clanTag} was not found after it was created.`);
  }
  return parent.clan_tag;
}

function cocRoleToWebsiteRole(role: string): string {
  const r = role.toLowerCase();
  if (r === 'leader') return 'Leader';
  if (r === 'coleader') return 'Co-Leader';
  if (r === 'elder') return 'Elder';
  return 'Member';
}

function normalizeRoleForComparison(role: string): string {
  const r = role.toLowerCase().trim();
  if (r === 'leader') return 'leader';
  if (r === 'co-leader' || r === 'coleader' || r === 'rep') return 'co-leader';
  if (r === 'staff' || r === 'elder' || r === 'admin') return 'elder';
  if (r === 'member') return 'member';
  if (r === 'filler') return 'filler';
  return r;
}

function normalizeRoleForSorting(role: string): string {
  const r = role.toLowerCase().trim();
  if (r === 'co-leader' || r === 'coleader') return 'co-leader';
  if (r === 'rep') return 'rep';
  if (r === 'staff') return 'staff';
  if (r === 'elder' || r === 'admin') return 'elder';
  return r;
}

const ROSTER_ROLE_ORDER: Record<string, number> = {
  leader: 0,
  rep: 1,
  'co-leader': 2,
  staff: 3,
  elder: 4,
  member: 5,
  filler: 6,
};

/* ───────────────────── handlers ───────────────────── */

// GET /api/tracked-clans — list tracked clans (family_clans)
// POST /api/tracked-clans — add clan (Developer)
// DELETE /api/tracked-clans?clan_tag=#TAG — remove clan (Developer)
async function handleTrackedClans(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, auth: AuthResult): Promise<void> {
  const method = req.method ?? 'GET';
  const isDev = isManagement(auth);

  if (method === 'GET') {
    try {
      const supabase = adminClient();
      const { data, error } = await supabase
        .from('family_clans')
        .select('clan_tag, clan_name')
        .order('clan_name', { ascending: true });
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true, clans: data ?? [] });
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Failed to load clans.' });
    }

    return;
  }

  if (!isDev) {
    send(res, 403, { ok: false, error: 'Developer or Admin role required.' });
    return;
  }

  if (method === 'POST') {
    const body = readJsonBody(req);
    const rawTag = String(body.clan_tag ?? '').trim();
    const clanName = String(body.clan_name ?? '').trim();
    if (!rawTag || !clanName) {
      send(res, 400, { ok: false, error: 'Clan tag and name are required.' });
      return;
    }
    try {
      const supabase = adminClient();
      const resolvedTag = await resolveClanTag(supabase, rawTag);
      const { error } = await supabase
        .from('family_clans')
        .upsert({ clan_tag: resolvedTag, clan_name: clanName }, { onConflict: 'clan_tag' });
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true, clan_tag: resolvedTag, clan_name: clanName });
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Add failed.' });
    }
    return;
  }

  if (method === 'DELETE') {
    const q = getQuery(req);
    const rawTag = q.clan_tag ?? '';
    if (!rawTag) {
      send(res, 400, { ok: false, error: 'Clan tag is required.' });
      return;
    }
    try {
      const supabase = adminClient();
      const resolvedTag = await resolveClanTag(supabase, rawTag);
      const { error } = await supabase.from('family_clans').delete().eq('clan_tag', resolvedTag);
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true, deleted: resolvedTag });
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Delete failed.' });
    }
    return;
  }

  send(res, 405, { ok: false, error: 'Use GET, POST, or DELETE.' });
}

interface DiscordProfileSummary {
  discord_id: string;
  nickname: string;
  username: string;
  avatar_url: string | null;
}

async function lookupDiscordProfile(discordId: string): Promise<DiscordProfileSummary> {
  const cleanId = discordId.trim();
  const stripDiscrim = (val: unknown): string =>
    typeof val === 'string' ? val.trim().replace(/#0$/, '') : '';
  let username = '';
  let nickname = '';
  let avatarUrl: string | null = null;
  const botToken = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
  const guildId = (process.env.DISCORD_GUILD_ID ?? '').trim() || '1285884592107720776';

  if (botToken && /^\d{15,22}$/.test(cleanId)) {
    let resolved = false;
    if (guildId) {
      try {
        const memberResp = await fetch(
          `https://discord.com/api/v10/guilds/${guildId}/members/${cleanId}`,
          { headers: { Authorization: `Bot ${botToken}` } }
        );
        if (memberResp.ok) {
          const member = (await memberResp.json()) as Record<string, unknown>;
          const dUser = (member.user ?? {}) as Record<string, unknown>;
          const liveUsername = stripDiscrim(dUser.username);
          const liveGlobalName =
            typeof dUser.global_name === 'string' && dUser.global_name.trim()
              ? dUser.global_name.trim()
              : null;
          const liveNick =
            typeof member.nick === 'string' && member.nick.trim()
              ? member.nick.trim()
              : null;

          if (liveUsername) username = liveUsername;
          nickname = liveNick || liveGlobalName || liveUsername || cleanId;

          const memberAvatar =
            typeof member.avatar === 'string' && member.avatar.trim()
              ? member.avatar.trim()
              : null;
          const userAvatar =
            typeof dUser.avatar === 'string' && dUser.avatar.trim()
              ? dUser.avatar.trim()
              : null;

          if (memberAvatar) {
            const ext = memberAvatar.startsWith('a_') ? 'gif' : 'png';
            avatarUrl = `https://cdn.discordapp.com/guilds/${guildId}/users/${cleanId}/avatars/${memberAvatar}.${ext}?size=256`;
          } else if (userAvatar) {
            const ext = userAvatar.startsWith('a_') ? 'gif' : 'png';
            avatarUrl = `https://cdn.discordapp.com/avatars/${cleanId}/${userAvatar}.${ext}?size=256`;
          }
          resolved = true;
        }
      } catch {
        // fallback to global user lookup
      }
    }

    if (!resolved) {
      try {
        const userResp = await fetch(`https://discord.com/api/v10/users/${cleanId}`, {
          headers: { Authorization: `Bot ${botToken}` },
        });
        if (userResp.ok) {
          const dUser = (await userResp.json()) as Record<string, unknown>;
          const liveUsername = stripDiscrim(dUser.username);
          const liveGlobalName =
            typeof dUser.global_name === 'string' && dUser.global_name.trim()
              ? dUser.global_name.trim()
              : null;
          if (liveUsername) username = liveUsername;
          nickname = liveGlobalName || liveUsername || cleanId;

          const userAvatar =
            typeof dUser.avatar === 'string' && dUser.avatar.trim()
              ? dUser.avatar.trim()
              : null;
          if (userAvatar) {
            const ext = userAvatar.startsWith('a_') ? 'gif' : 'png';
            avatarUrl = `https://cdn.discordapp.com/avatars/${cleanId}/${userAvatar}.${ext}?size=256`;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  if (!avatarUrl && /^\d{15,22}$/.test(cleanId)) {
    try {
      const defaultIdx = Number((BigInt(cleanId) >> 22n) % 6n);
      avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIdx}.png`;
    } catch {
      avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
    }
  }

  return {
    discord_id: cleanId,
    nickname: nickname || username || cleanId,
    username: username || cleanId,
    avatar_url: avatarUrl,
  };
}

function normalizeAccessLevel(rawLevel: unknown, rawAllowed?: unknown): AccessLevel {
  if (rawLevel === 'none' || rawLevel === 'view' || rawLevel === 'edit') return rawLevel;
  return rawAllowed === false ? 'none' : 'edit';
}

// GET/POST /api/access-management — manage allowlisted roles and per-clan page rules
async function handleAccessManagement(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (!isManagement(auth)) {
    send(res, 403, { ok: false, error: 'Developer or Admin role required.' });
    return;
  }
  const supabase = adminClient();
  if (req.method === 'GET') {
    const [{ data: users, error: usersError }, { data: clans, error: clansError }] = await Promise.all([
      supabase.from('allowed_user_ids').select('discord_user_id, role, created_at').order('created_at'),
      supabase.from('family_clans').select('clan_tag, clan_name').order('clan_name'),
    ]);

    let permissions: { clan_tag: string; role: string; page_key: string; allowed: boolean; access_level?: string }[] | null = null;
    let permissionsError: { message: string } | null = null;
    const permRes = await supabase
      .from('page_permissions')
      .select('clan_tag, role, page_key, allowed, access_level')
      .order('clan_tag');
    if (permRes.error) {
      const fallbackRes = await supabase
        .from('page_permissions')
        .select('clan_tag, role, page_key, allowed')
        .order('clan_tag');
      permissions = fallbackRes.data;
      permissionsError = fallbackRes.error;
    } else {
      permissions = permRes.data;
    }

    const error = usersError || clansError || permissionsError;
    if (error) {
      send(res, 500, { ok: false, error: error.message });
      return;
    }

    const enrichedUsers = await Promise.all(
      (users ?? []).map(async (user) => ({
        ...user,
        discord: await lookupDiscordProfile(String(user.discord_user_id ?? '')),
      }))
    );

    const normalizedPermissions = (permissions ?? []).map((p) => ({
      clan_tag: p.clan_tag,
      role: p.role,
      page_key: p.page_key,
      allowed: p.allowed,
      access_level: normalizeAccessLevel(p.access_level, p.allowed),
    }));

    const roles = [
      ...new Set([
        ...(users ?? []).map((user) => user.role).filter(Boolean),
        ...normalizedPermissions.map((p) => p.role).filter(Boolean),
      ]),
    ];
    send(res, 200, {
      ok: true,
      users: enrichedUsers,
      clans: clans ?? [],
      permissions: normalizedPermissions,
      roles,
    });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use GET or POST.' });
    return;
  }
  const body = readJsonBody(req);
  const action = String(body.action ?? '');
  if (action === 'save_user') {
    const discordUserId = String(body.discord_user_id ?? '').trim();
    const role = String(body.role ?? '').trim();
    if (!discordUserId || !role) {
      send(res, 400, { ok: false, error: 'Discord user ID and role are required.' });
      return;
    }
    const { error } = await supabase.from('allowed_user_ids').upsert({ discord_user_id: discordUserId, role }, { onConflict: 'discord_user_id' });
    if (error) {
      send(res, 500, { ok: false, error: error.message });
      return;
    }
    send(res, 200, { ok: true });
    return;
  }
  if (action === 'delete_user') {
    const discordUserId = String(body.discord_user_id ?? '').trim();
    if (!discordUserId) {
      send(res, 400, { ok: false, error: 'Discord user ID is required.' });
      return;
    }
    const { error } = await supabase.from('allowed_user_ids').delete().eq('discord_user_id', discordUserId);
    if (error) {
      send(res, 500, { ok: false, error: error.message });
      return;
    }
    send(res, 200, { ok: true });
    return;
  }
  if (action === 'create_role') {
    const role = String(body.role ?? '').trim();
    if (!role) {
      send(res, 400, { ok: false, error: 'Role name is required.' });
      return;
    }
    const defaultLevel = normalizeAccessLevel(body.default_level, true);
    const seedRows = (['cwl', 'fillers', 'wars', 'clan_management', 'audit_log'] as const).map((pageKey) => ({
      clan_tag: '*',
      role,
      page_key: pageKey,
      allowed: pageKey === 'clan_management' || pageKey === 'audit_log' ? false : defaultLevel !== 'none',
      access_level: pageKey === 'clan_management' || pageKey === 'audit_log' ? 'none' : defaultLevel,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from('page_permissions')
      .upsert(seedRows, { onConflict: 'clan_tag,role,page_key' });
    if (error) {
      send(res, 500, { ok: false, error: error.message });
      return;
    }
    send(res, 200, { ok: true, role });
    return;
  }
  if (action === 'delete_role') {
    const role = String(body.role ?? '').trim();
    if (!role) {
      send(res, 400, { ok: false, error: 'Role name is required.' });
      return;
    }
    if (['developer', 'admin'].includes(role.toLowerCase())) {
      send(res, 400, { ok: false, error: `Built-in role "${role}" cannot be deleted.` });
      return;
    }
    const reassignTo = String(body.reassign_to ?? '').trim();
    const { data: assignedUsers, error: checkErr } = await supabase
      .from('allowed_user_ids')
      .select('discord_user_id')
      .eq('role', role);
    if (checkErr) {
      send(res, 500, { ok: false, error: checkErr.message });
      return;
    }
    if ((assignedUsers?.length ?? 0) > 0) {
      if (!reassignTo || reassignTo === role) {
        send(res, 400, {
          ok: false,
          error: `${assignedUsers!.length} user(s) currently have the "${role}" role. Switch their role first or choose a replacement role.`,
        });
        return;
      }
      const { error: reassignErr } = await supabase
        .from('allowed_user_ids')
        .update({ role: reassignTo })
        .eq('role', role);
      if (reassignErr) {
        send(res, 500, { ok: false, error: reassignErr.message });
        return;
      }
    }
    const { error: delPermErr } = await supabase.from('page_permissions').delete().eq('role', role);
    if (delPermErr) {
      send(res, 500, { ok: false, error: delPermErr.message });
      return;
    }
    send(res, 200, { ok: true, deleted: role });
    return;
  }
  if (action === 'save_permission') {
    const clanTag = String(body.clan_tag ?? '').trim();
    const role = String(body.role ?? '').trim();
    const pageKey = String(body.page_key ?? '').trim();
    const accessLevel = normalizeAccessLevel(body.access_level, body.allowed);
    if (!clanTag || !role || !['cwl', 'fillers', 'wars', 'clan_management', 'clan_access', 'roster', 'clans', 'accounts', 'clan_home', 'war_weights', 'strike_board', 'strike_manager', 'user_management', 'audit_log'].includes(pageKey)) {
      send(res, 400, { ok: false, error: 'Clan, role, and a valid page are required.' });
      return;
    }
    const { error } = await supabase.from('page_permissions').upsert({
      clan_tag: clanTag,
      role,
      page_key: pageKey,
      allowed: accessLevel !== 'none',
      access_level: accessLevel,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'clan_tag,role,page_key' });
    if (error) {
      send(res, 500, { ok: false, error: error.message });
      return;
    }
    send(res, 200, { ok: true });
    return;
  }
  if (action === 'save_permissions') {
    const role = String(body.role ?? '').trim();
    const clanTags = Array.isArray(body.clan_tags)
      ? body.clan_tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [];
    const permissions = Array.isArray(body.permissions) ? body.permissions : [];
    const pageKeys = ['cwl', 'fillers', 'wars', 'clan_management', 'clan_access', 'clan_home', 'war_weights', 'strike_board', 'strike_manager', 'audit_log'];
    if (!role || clanTags.length === 0 || permissions.length === 0) {
      send(res, 400, { ok: false, error: 'Role, at least one clan scope, and permissions are required.' });
      return;
    }
    const rows = [];
    for (const clanTag of clanTags) {
      for (const permission of permissions) {
        if (!permission || typeof permission !== 'object') continue;
        const row = permission as Record<string, unknown>;
        const pageKey = String(row.page_key ?? '');
        if (!pageKeys.includes(pageKey)) continue;
        const accessLevel = normalizeAccessLevel(row.access_level, row.allowed);
        rows.push({
          clan_tag: clanTag,
          role,
          page_key: pageKey,
          allowed: accessLevel !== 'none',
          access_level: accessLevel,
          updated_at: new Date().toISOString(),
        });
      }
    }
    if (rows.length === 0) {
      send(res, 400, { ok: false, error: 'No valid page permissions were supplied.' });
      return;
    }
    const { error } = await supabase
      .from('page_permissions')
      .upsert(rows, { onConflict: 'clan_tag,role,page_key' });
    if (error) {
      send(res, 500, { ok: false, error: error.message });
      return;
    }
    send(res, 200, { ok: true, updated: rows.length });
    return;
  }
  send(res, 400, { ok: false, error: 'Unknown management action.' });
}

// GET /api/clan-roster?clan_tag=#TAG — roster for clan Home page
async function handleClanRoster(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined> }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'GET') {
    send(res, 405, { ok: false, error: 'Use GET.' });
    return;
  }
  const q = getQuery(req);
  const rawTag = q.clan_tag ?? '';
  if (!rawTag) {
    send(res, 400, { ok: false, error: 'Clan tag is required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, rawTag);
    if (!await canAccessClanPage(req, clanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You do not have access to this clan page.' });
      return;
    }
    const { data, error } = await supabase
      .from('clan_players')
      .select('id, player_name, player_tag, discord_id, town_hall, role, status, join_date, days_in_clan, war_weight, updated_date')
      .eq('clan_tag', clanTag);
    if (error) throw new Error(error.message);
    const players = [...(data ?? [])].sort((a, b) => {
      const roleDifference =
        (ROSTER_ROLE_ORDER[normalizeRoleForSorting(a.role ?? '')] ?? 99) -
        (ROSTER_ROLE_ORDER[normalizeRoleForSorting(b.role ?? '')] ?? 99);
      if (roleDifference !== 0) return roleDifference;
      const townHallDifference = (b.town_hall ?? 0) - (a.town_hall ?? 0);
      if (townHallDifference !== 0) return townHallDifference;
      const joinDateA = a.join_date ? new Date(a.join_date).getTime() : Number.MAX_SAFE_INTEGER;
      const joinDateB = b.join_date ? new Date(b.join_date).getTime() : Number.MAX_SAFE_INTEGER;
      if (joinDateA !== joinDateB) return joinDateA - joinDateB;
      return a.player_name.localeCompare(b.player_name);
    });
    send(res, 200, { ok: true, clan_tag: clanTag, players });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Failed to load roster.' });
  }
}

// POST /api/sync-clan-roster — manual roster sync from CoC API
// Status/role/name/town hall are validated against the in-game clan roster.
// Discord IDs are refreshed for EVERY player in the website roster (including
// players who are not currently in the in-game clan), using the linked_players table.
async function handleSyncClanRoster(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use POST.' });
    return;
  }
  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  if (!clanTagRaw) {
    send(res, 400, { ok: false, error: 'Clan tag is required.' });
    return;
  }
  const clean = clanTagRaw.toUpperCase().replace(/^#+/, '');
  if (!/^[0289CGJLPUVQRY]+$/.test(clean) || clean.length < 3) {
    send(res, 400, { ok: false, error: 'Invalid clan tag.' });
    return;
  }

  // Normalizes any tag to the "#TAG" uppercase form
  const normTag = (tag: unknown): string => `#${String(tag ?? '').trim().toUpperCase().replace(/^#+/, '')}`;

  try {
    const supabase = adminClient();
    const resolvedClanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canEditClanPage(req, resolvedClanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You only have view access to this clan page.' });
      return;
    }

    // Ensure the clan exists in family_clans (foreign key parent)
    const clanTag = await ensureClanParent(supabase, resolvedClanTag);

    let clan;
    try {
      clan = await getClan(clanTag);
    } catch {
      send(res, 404, { ok: false, error: `Clan ${clanTag} not found in CoC API.` });
      return;
    }

    const members = clan.memberList ?? [];
    const membersByTag = new Map(members.map((member) => [normTag(member.tag), member]));

    // Website roster (every player we need to check)
    const { data: existing, error: existingError } = await supabase
      .from('clan_players')
      .select('player_tag, role, join_date')
      .eq('clan_tag', clanTag);
    if (existingError) throw new Error(existingError.message);

    // Collect EVERY tag from the website roster (plus current in-game members),
    // in both "#TAG" and "TAG" formats so storage format differences don't cause misses.
    const lookupTags = new Set<string>();
    for (const tag of [...(existing ?? []).map((p) => p.player_tag), ...members.map((m) => m.tag)]) {
      const normalized = normTag(tag);
      lookupTags.add(normalized);
      lookupTags.add(normalized.slice(1));
    }

    // Look up Discord IDs for all of those tags
    const discordIdMap = new Map<string, string>();
    let discordLookupOk = false;
    let discordWarning: string | null = null;
    try {
      const playerbase = playerbaseAdminClient();
      const tagList = [...lookupTags];
      const CHUNK = 200;
      for (let i = 0; i < tagList.length; i += CHUNK) {
        const chunk = tagList.slice(i, i + CHUNK);
        const { data: linked, error: linkedError } = await playerbase
          .from('linked_players')
          .select('player_tag, discord_id')
          .in('player_tag', chunk);
        if (linkedError) throw new Error(linkedError.message);
        for (const item of linked ?? []) {
          const key = normTag(item.player_tag);
          const discordId = item.discord_id != null ? String(item.discord_id).trim() : '';
          if (discordId && !discordIdMap.has(key)) discordIdMap.set(key, discordId);
        }
      }
      discordLookupOk = true;
    } catch (err) {
      discordWarning = `Discord ID lookup failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    const now = new Date();

    let updated = 0;
    let missing = 0;
    let roleMismatches = 0;
    let discordLinked = 0;
    for (const player of existing ?? []) {
      const key = normTag(player.player_tag);
      const member = membersByTag.get(key);
      const isFiller = normalizeRoleForComparison(player.role ?? '') === 'filler';
      const roleMatches = normalizeRoleForComparison(player.role ?? '') === normalizeRoleForComparison(member?.role ?? '');
      const status = !member
        ? 'Missing from Clan'
        : isFiller || roleMatches
          ? 'All good'
          : 'Role Mismatch';
      if (status === 'Missing from Clan') missing += 1;
      if (status === 'Role Mismatch') roleMismatches += 1;

      const discordId = discordIdMap.get(key) ?? null;
      if (discordId) discordLinked += 1;

      const updates = {
        status,
        updated_date: now.toISOString(),
        // Name / town hall only come from the API for players currently in the clan
        ...(member
          ? {
              player_name: member.name,
              town_hall: member.townHallLevel ?? null,
            }
          : {}),
        // Discord ID is refreshed for EVERY roster player, in clan or not.
        // If the lookup itself failed, leave existing IDs untouched instead of wiping them.
        ...(discordLookupOk ? { discord_id: discordId } : {}),
      };
      const { error } = await supabase
        .from('clan_players')
        .update(updates)
        .eq('clan_tag', clanTag)
        .eq('player_tag', player.player_tag);
      if (error) throw new Error(error.message);
      updated += 1;
    }
    send(res, 200, {
      ok: true,
      updated,
      missing,
      role_mismatches: roleMismatches,
      discord_linked: discordLinked,
      warning: discordWarning,
      clan_tag: clanTag,
      clan_name: clan.name,
    });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Sync failed.' });
  }
}

// POST /api/edit-clan-player — edit player tag/role/join_date
async function handleEditClanPlayer(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use POST.' });
    return;
  }
  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const playerTagRaw = String(body.player_tag ?? '').trim();
  if (!clanTagRaw || !playerTagRaw) {
    send(res, 400, { ok: false, error: 'Clan tag and player tag are required.' });
    return;
  }

  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canEditClanPage(req, clanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You only have view access to this clan page.' });
      return;
    }
    const playerTag = `#${playerTagRaw.toUpperCase().replace(/^#+/, '')}`;

    const updates: Record<string, unknown> = {};
    const newPlayerTag = body.new_player_tag
      ? `#${String(body.new_player_tag).trim().toUpperCase().replace(/^#+/, '')}`
      : null;

    if (newPlayerTag) updates.player_tag = newPlayerTag;
    if (body.role) updates.role = body.role;
    if (body.join_date) updates.join_date = body.join_date;

    if (Object.keys(updates).length === 0) {
      send(res, 400, { ok: false, error: 'Nothing to update.' });
      return;
    }

    try {
      const supabase = adminClient();
      if (body.join_date) {
        const now = new Date();
        const oneDayMs = 24 * 60 * 60 * 1000;
        const joinTime = new Date(String(body.join_date)).getTime();
        updates.days_in_clan = Math.floor((now.getTime() - joinTime) / oneDayMs);
      }
      updates.updated_date = new Date().toISOString();

      const { data: parentCheck, error: parentCheckError } = await supabase
        .from('family_clans')
        .select('clan_tag')
        .eq('clan_tag', clanTag)
        .maybeSingle();
      if (parentCheckError) throw new Error(`Could not verify clan ${clanTag}: ${parentCheckError.message}`);
      if (!parentCheck?.clan_tag) {
        throw new Error(`Clan parent ${clanTag} is missing immediately before adding the player.`);
      }

      const { error, data } = await supabase
        .from('clan_players')
        .update(updates)
        .eq('clan_tag', clanTag)
        .eq('player_tag', playerTag)
        .select();

      if (error) throw new Error(error.message);
      if (!data || data.length === 0) {
        send(res, 404, { ok: false, error: 'Player not found in this clan.' });
        return;
      }
      send(res, 200, { ok: true, updated: data[0] });
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Update failed.' });
    }
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Update failed.' });
  }
}

// POST /api/edit-clan-players — batch edit player tags, roles, and join dates
async function handleEditClanPlayers(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use POST.' });
    return;
  }

  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (!clanTagRaw || updates.length === 0) {
    send(res, 400, { ok: false, error: 'Clan tag and at least one update are required.' });
    return;
  }

  const parsedUpdates: { playerTag: string; newPlayerTag: string; role: string; joinDate: string }[] = [];
  for (const update of updates) {
    if (!update || typeof update !== 'object') {
      send(res, 400, { ok: false, error: 'Each update must include a player tag, role, and join date.' });
      return;
    }
    const row = update as Record<string, unknown>;
    const playerTag = `#${String(row.player_tag ?? '').trim().toUpperCase().replace(/^#+/, '')}`;
    const newPlayerTag = `#${String(row.new_player_tag ?? '').trim().toUpperCase().replace(/^#+/, '')}`;
    const role = String(row.role ?? '').trim();
    const joinDate = String(row.join_date ?? '').trim();
    if (playerTag.length < 4 || newPlayerTag.length < 4 || !role || !joinDate) {
      send(res, 400, { ok: false, error: 'Each player must have a valid tag, role, and join date.' });
      return;
    }
    parsedUpdates.push({ playerTag, newPlayerTag, role, joinDate });
  }

  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canEditClanPage(req, clanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You only have view access to this clan page.' });
      return;
    }
    const now = new Date();
    const updated: string[] = [];
    const failed: string[] = [];

    for (const update of parsedUpdates) {
      const joinTime = new Date(update.joinDate).getTime();
      if (Number.isNaN(joinTime)) {
        failed.push(update.playerTag);
        continue;
      }
      const daysInClan = Math.floor((now.getTime() - joinTime) / (24 * 60 * 60 * 1000));
      const { data, error } = await supabase
        .from('clan_players')
        .update({
          player_tag: update.newPlayerTag,
          role: update.role,
          join_date: update.joinDate,
          days_in_clan: daysInClan,
          updated_date: now.toISOString(),
        })
        .eq('clan_tag', clanTag)
        .eq('player_tag', update.playerTag)
        .select('player_tag');
      if (error) throw new Error(error.message);
      if (data?.length) updated.push(update.newPlayerTag);
      else failed.push(update.playerTag);
    }

    send(res, 200, { ok: true, updated: updated.length, failed });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Batch update failed.' });
  }
}

// POST /api/add-clan-player — add player with auto-sync from CoC API
async function handleAddClanPlayer(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use POST.' });
    return;
  }
  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const playerTagRaw = String(body.player_tag ?? '').trim();
  if (!clanTagRaw || !playerTagRaw) {
    send(res, 400, { ok: false, error: 'Clan tag and player tag are required.' });
    return;
  }
  const cleanClan = clanTagRaw.toUpperCase().replace(/^#+/, '');
  const cleanPlayer = playerTagRaw.toUpperCase().replace(/^#+/, '');
  if (!/^[0289CGJLPUVQRY]+$/.test(cleanClan) || cleanClan.length < 3) {
    send(res, 400, { ok: false, error: 'Invalid clan tag.' });
    return;
  }
  if (!/^[0289CGJLPUVQRY]+$/.test(cleanPlayer) || cleanPlayer.length < 3) {
    send(res, 400, { ok: false, error: 'Invalid player tag.' });
    return;
  }

  try {
    const supabase = adminClient();
    const resolvedClanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canEditClanPage(req, resolvedClanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You only have view access to this clan page.' });
      return;
    }
    const playerTag = `#${cleanPlayer}`;

    // Ensure the clan exists in family_clans (foreign key parent)
    const clanTag = await ensureClanParent(supabase, resolvedClanTag);

    // Fetch player from CoC API
    let player;
    try {
      player = await getPlayer(playerTag);
    } catch {
      send(res, 404, { ok: false, error: `Player ${playerTag} not found in CoC API.` });
      return;
    }

    let discordId: string | null = null;
    try {
      const playerbase = playerbaseAdminClient();
      const { data: linked, error: linkedError } = await playerbase
        .from('linked_players')
        .select('discord_id')
        .eq('player_tag', playerTag)
        .maybeSingle();
      if (!linkedError && linked) {
        discordId = linked.discord_id != null ? String(linked.discord_id) : null;
      }
    } catch {
      // ignore
    }

    const role = cocRoleToWebsiteRole(player.role ?? 'member');
    const now = new Date().toISOString();

    const { data: parentCheck, error: parentCheckError } = await supabase
      .from('family_clans')
      .select('clan_tag')
      .eq('clan_tag', clanTag)
      .maybeSingle();
    if (parentCheckError) throw new Error(`Could not verify clan ${clanTag}: ${parentCheckError.message}`);
    if (!parentCheck?.clan_tag) {
      throw new Error(`Clan parent ${clanTag} is missing immediately before adding the player.`);
    }

    const { error, data } = await supabase
      .from('clan_players')
      .insert({
        clan_tag: clanTag,
        player_name: player.name,
        player_tag: player.tag,
        discord_id: discordId,
        town_hall: player.townHallLevel ?? null,
        role,
        status: 'All good',
        join_date: now,
        days_in_clan: 0,
        war_weight: null,
        updated_date: now,
      })
      .select();

    if (error) {
      if (error.code === '23505') {
        send(res, 409, { ok: false, error: 'Player already exists in this clan roster.' });
        return;
      }
      throw new Error(error.message);
    }

    send(res, 200, { ok: true, added: data?.[0] ?? null });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Add player failed.' });
  }
}

// POST /api/delete-clan-player — remove player from clan roster
async function handleDeleteClanPlayer(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use POST.' });
    return;
  }
  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const playerTagRaw = String(body.player_tag ?? '').trim();
  if (!clanTagRaw || !playerTagRaw) {
    send(res, 400, { ok: false, error: 'Clan tag and player tag are required.' });
    return;
  }

  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canEditClanPage(req, clanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You only have view access to this clan page.' });
      return;
    }
    const playerTag = `#${playerTagRaw.toUpperCase().replace(/^#+/, '')}`;

    const { error, data } = await supabase
      .from('clan_players')
      .delete()
      .eq('clan_tag', clanTag)
      .eq('player_tag', playerTag)
      .select();

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      send(res, 404, { ok: false, error: 'Player not found in this clan.' });
      return;
    }
    send(res, 200, { ok: true, deleted: data[0] });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Delete player failed.' });
  }
}

// GET /api/war-weights?clan_tag=#TAG — war weights for clan
async function handleWarWeights(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined> }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'GET') {
    send(res, 405, { ok: false, error: 'Use GET.' });
    return;
  }
  const q = getQuery(req);
  const rawTag = q.clan_tag ?? '';
  if (!rawTag) {
    send(res, 400, { ok: false, error: 'Clan tag is required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, rawTag);
    if (!await canAccessClanPage(req, clanTag, 'war_weights')) {
      send(res, 403, { ok: false, error: 'You do not have access to war weights.' });
      return;
    }
    const { data, error } = await supabase
      .from('war_weights')
      .select('id, player_name, player_tag, town_hall, value, war_weight, map_position, updated_date')
      .eq('clan_tag', clanTag)
      .order('map_position', { ascending: true });
    if (error) throw new Error(error.message);
    send(res, 200, { ok: true, clan_tag: clanTag, weights: data ?? [] });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Failed to load war weights.' });
  }
}

// POST /api/sync-war-weights — sync war weights from current CoC war
async function handleSyncWarWeights(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use POST.' });
    return;
  }
  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  if (!clanTagRaw) {
    send(res, 400, { ok: false, error: 'Clan tag is required.' });
    return;
  }
  const clean = clanTagRaw.toUpperCase().replace(/^#+/, '');
  if (!/^[0289CGJLPUVQRY]+$/.test(clean) || clean.length < 3) {
    send(res, 400, { ok: false, error: 'Invalid clan tag.' });
    return;
  }

  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canEditClanPage(req, clanTag, 'war_weights')) {
      send(res, 403, { ok: false, error: 'You only have view access to war weights.' });
      return;
    }
    let war;
    try {
      war = await getCurrentWar(clanTag);
    } catch {
      send(res, 404, { ok: false, error: `No current war found for ${clanTag}.` });
      return;
    }
    if (!war) {
      send(res, 404, { ok: false, error: `The clan is not currently in a war.` });
      return;
    }

    const roster = [...(war.clan.members ?? [])]
      .sort((a, b) => (a.mapPosition ?? 999) - (b.mapPosition ?? 999));

    const { data: existingWeights, error: existingError } = await supabase
      .from('war_weights')
      .select('player_tag, value');
    if (existingError) throw new Error(existingError.message);

    if (roster.length === 0) {
      send(res, 200, {
        ok: true,
        updated: 0,
        message: 'No roster members in war.',
      });
      return;
    }

    const previousValues = new Map<string, number>();
    // Fallback: weights set on the Home page (clan_players.war_weight = value * 5)
    const { data: homeRows } = await supabase
      .from('clan_players')
      .select('player_tag, war_weight')
      .eq('clan_tag', clanTag);
    for (const row of homeRows ?? []) {
      if (row.war_weight != null) previousValues.set(row.player_tag, Math.round(Number(row.war_weight) / 5));
    }
    for (const weight of existingWeights ?? []) {
      if (weight.value != null) previousValues.set(weight.player_tag, weight.value);
    }
    const now = new Date().toISOString();
    const upserts = roster.map((member, index) => {
      const th = member.townhallLevel ?? 0;
      const value = previousValues.get(member.tag) ?? 0;
      return {
        clan_tag: clanTag,
        player_name: member.name,
        player_tag: member.tag,
        town_hall: th,
        value,
        war_weight: value * 5,
        map_position: member.mapPosition ?? index + 1,
        updated_date: now,
      };
    });

    const CHUNK = 50;
    let updated = 0;
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const chunk = upserts.slice(i, i + CHUNK);
      const { error } = await supabase.from('war_weights').upsert(chunk, { onConflict: 'player_tag' });
      if (error) throw new Error(error.message);
      updated += chunk.length;
    }

    // Remove rows for this clan that are not in the current war roster
    const rosterTags = new Set(roster.map((m) => m.tag));
    const { data: clanRows, error: clanRowsError } = await supabase
      .from('war_weights')
      .select('player_tag')
      .eq('clan_tag', clanTag);
    if (clanRowsError) throw new Error(clanRowsError.message);
    const staleTags = (clanRows ?? []).map((r) => r.player_tag).filter((t) => !rosterTags.has(t));
    for (let i = 0; i < staleTags.length; i += CHUNK) {
      const { error } = await supabase
        .from('war_weights')
        .delete()
        .eq('clan_tag', clanTag)
        .in('player_tag', staleTags.slice(i, i + CHUNK));
      if (error) throw new Error(error.message);
    }

    send(res, 200, {
      ok: true,
      updated,
      clan_tag: clanTag,
      state: war.state,
      message: `Synced ${updated} war weights for ${clanTag}`,
    });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Sync failed.' });
  }
}

// POST /api/edit-war-weight — edit value, recalculates war_weight = value * 5
async function handleEditWarWeight(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use POST.' });
    return;
  }
  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const playerTagRaw = String(body.player_tag ?? '').trim();
  const valueNum = Number(body.value);
  if (!clanTagRaw || !playerTagRaw) {
    send(res, 400, { ok: false, error: 'Clan tag and player tag are required.' });
    return;
  }
  if (body.value === null || body.value === undefined || !Number.isInteger(valueNum) || valueNum < 0) {
    send(res, 400, { ok: false, error: 'Value must be a whole number of 0 or greater.' });
    return;
  }

  try {
    const supabase = adminClient({ skip: true });
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canEditClanPage(req, clanTag, 'war_weights')) {
      send(res, 403, { ok: false, error: 'You only have view access to war weights.' });
      return;
    }
    const playerTag = `#${playerTagRaw.toUpperCase().replace(/^#+/, '')}`;

    try {
      const now = new Date().toISOString();
      // Update war_weights if the player has a row (players who joined after the war may not)
      const [{ error, data }, { data: playerRows, error: playerError }, { data: clanRow }] = await Promise.all([
        supabase
          .from('war_weights')
          .update({
            value: valueNum,
            war_weight: valueNum * 5,
            updated_date: now,
          })
          .eq('clan_tag', clanTag)
          .eq('player_tag', playerTag)
          .select(),
        // Also sync to clan_players so the home page roster reflects the change
        supabase
          .from('clan_players')
          .update({ war_weight: valueNum * 5, updated_date: now })
          .eq('clan_tag', clanTag)
          .eq('player_tag', playerTag)
          .select('player_tag'),
        supabase.from('family_clans').select('clan_name').eq('clan_tag', clanTag).maybeSingle(),
      ]);
      if (error) throw new Error(error.message);
      if (playerError) throw new Error(playerError.message);

      if ((!data || data.length === 0) && (!playerRows || playerRows.length === 0)) {
        send(res, 404, { ok: false, error: 'Player not found.' });
        return;
      }

      await recordAuditSummaryEntry({
        table_name: 'war_weights',
        operation: 'UPDATE',
        clan_tag: clanTag,
        action: 'war_weights.edit',
        new_data: {
          clan_tag: clanTag,
          clan_name: clanRow?.clan_name ?? clanTag,
          updated_count: 1,
        },
        changed_fields: ['war_weight'],
      });

      send(res, 200, { ok: true, updated: data?.[0] ?? playerRows?.[0] });
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Update failed.' });
    }
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Update failed.' });
  }
}

// POST /api/edit-war-weights — batch edit values, recalculates war_weight = value * 5
async function handleEditWarWeights(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use POST.' });
    return;
  }

  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (!clanTagRaw || updates.length === 0) {
    send(res, 400, { ok: false, error: 'Clan tag and at least one update are required.' });
    return;
  }

  const parsedUpdates: { playerTag: string; value: number }[] = [];
  for (const update of updates) {
    if (!update || typeof update !== 'object') {
      send(res, 400, { ok: false, error: 'Each update must include a player tag and value.' });
      return;
    }
    const row = update as Record<string, unknown>;
    const playerTag = `#${String(row.player_tag ?? '').trim().toUpperCase().replace(/^#+/, '')}`;
    const value = row.value;
    if (
      playerTag.length < 4 ||
      value === null ||
      value === undefined ||
      !Number.isInteger(value) ||
      Number(value) < 0
    ) {
      send(res, 400, { ok: false, error: 'Each value must be a whole number of 0 or greater.' });
      return;
    }
    parsedUpdates.push({ playerTag, value: Number(value) });
  }

  try {
    const supabase = adminClient({ skip: true });
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canEditClanPage(req, clanTag, 'war_weights')) {
      send(res, 403, { ok: false, error: 'You only have view access to war weights.' });
      return;
    }
    const now = new Date().toISOString();
    let updated = 0;
    const failed: string[] = [];

    const results = await Promise.all(
      parsedUpdates.map(async (update) => {
        const [{ data, error }, { data: cpData, error: cpError }] = await Promise.all([
          supabase
            .from('war_weights')
            .update({
              value: update.value,
              war_weight: update.value * 5,
              updated_date: now,
            })
            .eq('clan_tag', clanTag)
            .eq('player_tag', update.playerTag)
            .select('player_tag'),
          // Also sync to clan_players so the home page roster reflects the change
          supabase
            .from('clan_players')
            .update({ war_weight: update.value * 5, updated_date: now })
            .eq('clan_tag', clanTag)
            .eq('player_tag', update.playerTag)
            .select('player_tag'),
        ]);
        if (error) throw new Error(error.message);
        if (cpError) throw new Error(cpError.message);
        return {
          playerTag: update.playerTag,
          ok: Boolean(data?.length || cpData?.length),
        };
      })
    );

    for (const r of results) {
      if (r.ok) updated += 1;
      else failed.push(r.playerTag);
    }

    if (updated > 0) {
      const { data: clanRow } = await supabase
        .from('family_clans')
        .select('clan_name')
        .eq('clan_tag', clanTag)
        .maybeSingle();

      await recordAuditSummaryEntry({
        table_name: 'war_weights',
        operation: 'UPDATE',
        clan_tag: clanTag,
        action: 'war_weights.edit_batch',
        new_data: {
          clan_tag: clanTag,
          clan_name: clanRow?.clan_name ?? clanTag,
          updated_count: updated,
        },
        changed_fields: ['war_weight'],
      });
    }

    send(res, 200, { ok: true, updated, failed });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Batch update failed.' });
  }
}

// POST /api/sync — combined fillers + wars
async function handleSync(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined> }, res: { status: (code: number) => { json: (body: unknown) => void } }): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    send(res, 405, { ok: false, error: 'Use POST.' });
    return;
  }
  try {
    // Inline sync-fillers logic
    const supabase = adminClient();
    const { data: fillerData, error: fillerError } = await supabase.from('filler_accounts').select('player_tag');
    if (fillerError) throw new Error(fillerError.message);
    const tags = (fillerData ?? []).map((row) => row.player_tag as string);
    let fillersUpdated = 0;
    const fillersErrors: string[] = [];
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
          fillersUpdated++;
        } else {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          if (message.includes('404') || message.includes('Not found')) {
            // missing
          } else if (fillersErrors.length < 10) {
            fillersErrors.push(`${batch[j]}: ${message.slice(0, 160)}`);
          }
        }
      }
    }

    // Inline sync-wars logic
    const [{ data: clanRows, error: clanError }, { data: settingRows, error: settingError }] =
      await Promise.all([
        supabase.from('family_clans').select('clan_tag'),
        supabase.from('bot_settings').select('setting_value').eq('setting_key', 'fwa_sync_state'),
      ]);
    if (clanError) throw new Error(clanError.message);
    if (settingError) throw new Error(settingError.message);

    const familyTags = (clanRows ?? []).map((row) => row.clan_tag as string);
    const syncState = settingRows?.[0]?.setting_value === 'Low' ? 'Low' : 'High';

    const points = await getFwaPoints(true);
    let warsChecked = 0;
    let warsUpserted = 0;
    let warsSkipped = 0;
    let notInWar = 0;
    let privateLog = 0;
    let privateLogSample = '';
    const warsErrors: string[] = [];

    for (const tag of familyTags) {
      warsChecked++;
      let war;
      try {
        war = await getCurrentWar(tag);
      } catch (error) {
        if (error instanceof PrivateWarLog) {
          warsSkipped++;
          privateLog++;
          if (!privateLogSample) privateLogSample = error.message.replace(/^\/clans\/[^:]+:\s*/, '').slice(0, 120);
          continue;
        }
        if (error instanceof CocMaintenance) {
          send(res, 200, {
            ok: true,
            fillers: { updated: fillersUpdated, errors: fillersErrors },
            wars: { checked: warsChecked, upserted: warsUpserted, skipped: warsSkipped, skipDetail: `notInWar=${notInWar} privateLog=${privateLog}`, syncFlipped: false, errors: warsErrors },
            syncedAt: new Date().toISOString(),
          });
          return;
        }
        warsErrors.push(`${tag}: ${(error as Error).message.slice(0, 160)}`);
        continue;
      }
      if (!war) {
        warsSkipped++;
        notInWar++;
        continue;
      }

      const endTime = toUnixSeconds(war.endTime);
      if (!endTime) {
        warsSkipped++;
        continue;
      }

      try {
        await supabase.from('family_wars').delete().eq('clan_tag', tag).neq('end_time', endTime);
        const { data: existing, error: selectError } = await supabase
          .from('family_wars')
          .select('war_result')
          .eq('clan_tag', tag)
          .eq('end_time', endTime);
        if (selectError) throw new Error(selectError.message);

        const isNewWar = !existing || existing.length === 0;

        const effectiveSync = syncState;

        const freshPoints = isNewWar ? await getFwaPoints(true) : points;
        const ourPoints = lookupPoints(freshPoints, war.clan.tag);
        const opponentPoints = lookupPoints(freshPoints, war.opponent.tag);
        const warResult = calculateFwaResult(ourPoints, opponentPoints, war.clan.tag, war.opponent.tag, effectiveSync);

        const row = {
          clan_tag: tag,
          clan_badge_url: war.clan.badgeUrls?.medium ?? war.clan.badgeUrls?.large ?? war.clan.badgeUrls?.small ?? null,
          opponent_name: war.opponent.name,
          opponent_tag: war.opponent.tag,
          state: war.state,
          prep_start_time: toUnixSeconds(war.preparationStartTime),
          end_time: endTime,
          stars: war.clan.stars,
          attacks_used: war.clan.attacks,
          our_points: ourPoints,
          opponent_points: opponentPoints,
          sync_used: effectiveSync,
          war_result: warResult,
          opponent_stars: war.opponent.stars,
          opponent_attacks_used: war.opponent.attacks,
        };

        if (isNewWar) {
          const { error: insertError } = await supabase.from('family_wars').insert(row);
          if (insertError) throw new Error(insertError.message);
        } else {
          const { error: updateError } = await supabase
            .from('family_wars')
            .update(row)
            .eq('clan_tag', tag)
            .eq('end_time', endTime);
          if (updateError) throw new Error(updateError.message);
        }
        warsUpserted++;
      } catch (error) {
        warsErrors.push(`${tag}: ${(error as Error).message.slice(0, 160)}`);
      }
    }

    send(res, 200, {
      ok: true,
      fillers: { updated: fillersUpdated, errors: fillersErrors },
      wars: {
        checked: warsChecked,
        upserted: warsUpserted,
        skipped: warsSkipped,
        skipDetail: `notInWar=${notInWar} privateLog=${privateLog}${privateLogSample ? ` (${privateLogSample})` : ''}`,
        syncFlipped: false,
        errors: warsErrors.slice(0, 10),
      },
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Sync failed.' });
  }
}

// POST /api/sync-settings — update bot_settings (Developer)
async function handleSyncSettings(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, auth: AuthResult): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use POST.' });
    return;
  }
  if (!auth.ok || !await canEditClanPage(req, '*', 'wars')) {
    send(res, 403, { ok: false, error: 'Wars edit access is required to change the FWA sync state.' });
    return;
  }
  const body = readJsonBody(req);
  const settingKey = String(body.setting_key ?? '');
  const settingValue = String(body.setting_value ?? '');
  const ALLOWED_VALUES: Record<string, string[]> = {
    fwa_sync_state: ['Low', 'High'],
  };
  if (!ALLOWED_VALUES[settingKey]?.includes(settingValue)) {
    send(res, 400, { ok: false, error: 'Unsupported setting or value.' });
    return;
  }
  try {
    const supabase = adminClient();
    const { error } = await supabase
      .from('bot_settings')
      .update({ setting_value: settingValue })
      .eq('setting_key', settingKey);
    if (error) throw new Error(error.message);
    send(res, 200, { ok: true, setting_key: settingKey, setting_value: settingValue });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Save failed.' });
  }
}

// Display name of whoever is calling (for the season audit trail).
async function getActorName(req: { headers: Record<string, string | string[] | undefined>; url: string }): Promise<string> {
  const authHeader = getHeader(req, 'authorization');
  const supplied = getHeader(req, 'x-cron-secret');
  if (CRON_SECRET && (supplied === CRON_SECRET || authHeader === `Bearer ${CRON_SECRET}`)) return 'system';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return 'unknown';
  try {
    const { data } = await adminClient().auth.getUser(token);
    const user = data?.user;
    if (!user) return 'unknown';
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const pick = [meta.custom_claims && (meta.custom_claims as Record<string, unknown>).global_name, meta.full_name, meta.name, user.email]
      .find((value) => typeof value === 'string' && value.trim());
    return typeof pick === 'string' ? pick.trim() : user.id;
  } catch {
    return 'unknown';
  }
}

const CWL_DISCORD_GUILD_ID = '1519252846648889405';

// GET /api/discord-profile — fetch live Discord nickname, @username, Discord ID, and avatar via Discord Bot API
async function handleDiscordProfile(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined> },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (req.method && req.method !== 'GET') {
    send(res, 405, { ok: false, error: 'Use GET.' });
    return;
  }
  if (!auth.ok) {
    send(res, 401, { ok: false, error: 'Unauthorized.' });
    return;
  }

  const authHeader = getHeader(req, 'authorization');
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) {
    send(res, 401, { ok: false, error: 'Missing bearer token.' });
    return;
  }

  try {
    const supabase = adminClient();
    const { data, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !data?.user) {
      send(res, 401, { ok: false, error: userErr?.message || 'Could not resolve user.' });
      return;
    }

    const user = data.user;
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const discordIdentity = user.identities?.find((id) => id.provider === 'discord');
    const idData = (discordIdentity?.identity_data ?? {}) as Record<string, unknown>;
    const customClaims = (meta.custom_claims ?? idData.custom_claims ?? {}) as Record<string, unknown>;

    const discordId = String(
      meta.provider_id ??
        discordIdentity?.id ??
        idData.provider_id ??
        idData.sub ??
        meta.sub ??
        ''
    ).trim();

    const stripDiscrim = (val: unknown): string =>
      typeof val === 'string' ? val.trim().replace(/#0$/, '') : '';

    let username =
      stripDiscrim(meta.user_name) ||
      stripDiscrim(idData.username) ||
      stripDiscrim(meta.name) ||
      '';
    let nickname =
      (typeof meta.discord_nickname === 'string' && meta.discord_nickname.trim()) ||
      (typeof customClaims.global_name === 'string' && customClaims.global_name.trim()) ||
      (typeof meta.full_name === 'string' && meta.full_name.trim()) ||
      (typeof idData.full_name === 'string' && idData.full_name.trim()) ||
      username;
    let avatarUrl =
      (typeof meta.avatar_url === 'string' && meta.avatar_url.trim()) ||
      (typeof idData.avatar_url === 'string' && idData.avatar_url.trim()) ||
      null;

    const botToken = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
    const guildId = (process.env.DISCORD_GUILD_ID ?? '').trim() || CWL_DISCORD_GUILD_ID;

    if (botToken && /^\d{15,22}$/.test(discordId)) {
      let resolvedFromDiscord = false;

      // 1. Try Guild Member endpoint first (gives server nickname + guild avatar + user object)
      if (guildId) {
        try {
          const memberResp = await fetch(
            `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
            { headers: { Authorization: `Bot ${botToken}` } }
          );
          if (memberResp.ok) {
            const member = (await memberResp.json()) as Record<string, unknown>;
            const dUser = (member.user ?? {}) as Record<string, unknown>;
            const liveUsername = stripDiscrim(dUser.username);
            const liveGlobalName =
              typeof dUser.global_name === 'string' && dUser.global_name.trim()
                ? dUser.global_name.trim()
                : null;
            const liveNick =
              typeof member.nick === 'string' && member.nick.trim()
                ? member.nick.trim()
                : null;

            if (liveUsername) username = liveUsername;
            nickname = liveNick || liveGlobalName || liveUsername || nickname;

            const memberAvatar =
              typeof member.avatar === 'string' && member.avatar.trim()
                ? member.avatar.trim()
                : null;
            const userAvatar =
              typeof dUser.avatar === 'string' && dUser.avatar.trim()
                ? dUser.avatar.trim()
                : null;

            if (memberAvatar) {
              const ext = memberAvatar.startsWith('a_') ? 'gif' : 'png';
              avatarUrl = `https://cdn.discordapp.com/guilds/${guildId}/users/${discordId}/avatars/${memberAvatar}.${ext}?size=256`;
            } else if (userAvatar) {
              const ext = userAvatar.startsWith('a_') ? 'gif' : 'png';
              avatarUrl = `https://cdn.discordapp.com/avatars/${discordId}/${userAvatar}.${ext}?size=256`;
            }
            resolvedFromDiscord = true;
          }
        } catch {
          // fall back to global user lookup
        }
      }

      // 2. Fallback to global Discord User endpoint if not found in guild
      if (!resolvedFromDiscord) {
        try {
          const userResp = await fetch(`https://discord.com/api/v10/users/${discordId}`, {
            headers: { Authorization: `Bot ${botToken}` },
          });
          if (userResp.ok) {
            const dUser = (await userResp.json()) as Record<string, unknown>;
            const liveUsername = stripDiscrim(dUser.username);
            const liveGlobalName =
              typeof dUser.global_name === 'string' && dUser.global_name.trim()
                ? dUser.global_name.trim()
                : null;
            if (liveUsername) username = liveUsername;
            nickname = liveGlobalName || liveUsername || nickname;

            const userAvatar =
              typeof dUser.avatar === 'string' && dUser.avatar.trim()
                ? dUser.avatar.trim()
                : null;
            if (userAvatar) {
              const ext = userAvatar.startsWith('a_') ? 'gif' : 'png';
              avatarUrl = `https://cdn.discordapp.com/avatars/${discordId}/${userAvatar}.${ext}?size=256`;
            }
            resolvedFromDiscord = true;
          }
        } catch {
          // ignore
        }
      }

      // 3. Persist refreshed profile metadata into Supabase Auth user_metadata in background
      if (resolvedFromDiscord) {
        void supabase.auth.admin
          .updateUserById(user.id, {
            user_metadata: {
              ...meta,
              user_name: username || meta.user_name,
              full_name: nickname || meta.full_name,
              discord_nickname: nickname,
              avatar_url: avatarUrl || meta.avatar_url,
            },
          })
          .catch(() => {});
      }
    }

    send(res, 200, {
      ok: true,
      discord_id: discordId || null,
      nickname: nickname || username || 'Not available',
      username: username || 'Not available',
      avatar_url: avatarUrl,
      role: auth.role ?? null,
    });
  } catch (err) {
    send(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to load Discord profile.',
    });
  }
}

interface DiscordGuildRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

async function fetchCwlGuildRoles(): Promise<{ roles: DiscordGuildRole[]; warning: string | null }> {
  const token = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
  if (!token) {
    return { roles: [], warning: 'DISCORD_BOT_TOKEN is not configured on the server; Discord roles could not be loaded.' };
  }
  try {
    const response = await fetch(`https://discord.com/api/v10/guilds/${CWL_DISCORD_GUILD_ID}/roles`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!response.ok) {
      return { roles: [], warning: `Discord roles sync failed (HTTP ${response.status}).` };
    }
    const raw = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(raw)) return { roles: [], warning: null };
    const roles: DiscordGuildRole[] = raw
      .filter((r) => r && r.id !== CWL_DISCORD_GUILD_ID && r.name !== '@everyone' && r.managed !== true)
      .map((r) => ({
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        color: Number(r.color ?? 0),
        position: Number(r.position ?? 0),
      }))
      .filter((r) => r.id && r.name)
      .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
    return { roles, warning: null };
  } catch (err) {
    return { roles: [], warning: `Discord roles sync failed: ${err instanceof Error ? err.message : 'unknown error'}` };
  }
}

// GET/POST /api/cwl-roster — CWL seasons, season clans and roster assignments
async function handleCwlRoster(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, auth: AuthResult): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use GET or POST.' });
    return;
  }
  if (!auth.ok) {
    send(res, 401, { ok: false, error: 'Unauthorized.' });
    return;
  }
  const normTag = (tag: unknown): string => `#${String(tag ?? '').trim().toUpperCase().replace(/^#+/, '')}`;
  const fail = (code: number, error: string) => send(res, code, { ok: false, error });

  try {
    const supabase = adminClient();
    const getActive = async () => {
      const { data, error } = await supabase.from('cwl_seasons').select('*').eq('status', 'active').maybeSingle();
      if (error) throw new Error(error.message);
      return data as { id: string; name: string } | null;
    };

    if (method === 'GET') {
      const season = await getActive();
      const [{ data: past, error: pastError }, { data: allClans, error: clansError }, { data: entries, error: entriesError }, { data: rawEntries }, rolesResult] = await Promise.all([
        supabase.from('cwl_seasons').select('*').eq('status', 'closed').order('closed_at', { ascending: false }).limit(10),
        supabase.from('cwl_clans').select('clan_tag, clan_name, cwl_league, badge_url'),
        supabase.from('cwl_entries_view').select('*').order('created_date', { ascending: true }),
        supabase.from('cwl_entries').select('id, status, current_clan, cwl_assigned_at'),
        fetchCwlGuildRoles(),
      ]);
      if (pastError) throw new Error(pastError.message);
      if (clansError) throw new Error(clansError.message);
      if (entriesError) throw new Error(entriesError.message);
      const rawById = new Map((rawEntries ?? []).map((row) => [row.id as string, row as { status?: string | null; current_clan?: string | null; cwl_assigned_at?: string | null }]));

      let seasonClans: unknown[] = [];
      if (season) {
        const { data, error } = await supabase
          .from('cwl_season_clans')
          .select('*')
          .eq('season_id', season.id)
          .is('removed_at', null)
          .order('added_at', { ascending: true });
        if (error) throw new Error(error.message);
        seasonClans = data ?? [];
      }

      const lookup = new Set<string>();
      for (const entry of entries ?? []) {
        const n = normTag(entry.player_tag);
        lookup.add(n);
        lookup.add(n.slice(1));
      }
      const discordMap = new Map<string, string>();
      let warning: string | null = null;
      try {
        const playerbase = playerbaseAdminClient();
        const list = [...lookup];
        for (let i = 0; i < list.length; i += 200) {
          const { data: linked, error: linkedError } = await playerbase
            .from('linked_players')
            .select('player_tag, discord_id')
            .in('player_tag', list.slice(i, i + 200));
          if (linkedError) throw new Error(linkedError.message);
          for (const item of linked ?? []) {
            const key = normTag(item.player_tag);
            const id = item.discord_id != null ? String(item.discord_id).trim() : '';
            if (id && !discordMap.has(key)) discordMap.set(key, id);
          }
        }
      } catch (lookupError) {
        warning = `Discord ID lookup failed: ${lookupError instanceof Error ? lookupError.message : 'unknown error'}`;
      }

      const warnings = [warning, rolesResult.warning].filter(Boolean);
      send(res, 200, {
        ok: true,
        warning: warnings.length > 0 ? warnings.join(' · ') : null,
        season,
        past_seasons: past ?? [],
        clans: allClans ?? [],
        season_clans: seasonClans,
        discord_roles: rolesResult.roles,
        entries: (entries ?? []).map((entry) => {
          const extra = rawById.get(entry.id as string);
          return {
            ...entry,
            status: entry.status ?? extra?.status ?? null,
            current_clan: entry.current_clan ?? extra?.current_clan ?? null,
            cwl_assigned_at: entry.cwl_assigned_at ?? extra?.cwl_assigned_at ?? null,
            discord_id: discordMap.get(normTag(entry.player_tag)) ?? null,
          };
        }),
      });
      return;
    }

    // ───────── POST actions ─────────
    const body = readJsonBody(req);
    const action = String(body.action ?? '');

    if (action === 'sync_roles') {
      const { roles, warning } = await fetchCwlGuildRoles();
      if (warning) return fail(502, warning);
      send(res, 200, { ok: true, discord_roles: roles });
      return;
    }
    const actor = await getActorName(req);
    const now = new Date().toISOString();
    const cleanName = (value: unknown): string => String(value ?? '').trim().replace(/\s+/g, ' ');

    const clearAssignments = async () => {
      const { error } = await supabase
        .from('cwl_entries')
        .update({ cwl_clan_tag: null, cwl_clan_name: null })
        .not('cwl_clan_tag', 'is', null);
      if (error) throw new Error(error.message);
    };

    if (action === 'create_season') {
      const name = cleanName(body.name);
      if (!name || name.length > 60) return fail(400, 'Season name is required (max 60 characters).');
      const active = await getActive();
      if (active) {
        const { error } = await supabase
          .from('cwl_seasons')
          .update({ status: 'closed', closed_by: actor, closed_at: now })
          .eq('id', active.id);
        if (error) throw new Error(error.message);
      }
      if (body.clear_assignments === true) await clearAssignments();
      const { error } = await supabase.from('cwl_seasons').insert({ name, status: 'active', created_by: actor });
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true });
      return;
    }

    const season = await getActive();
    if (!season) return fail(400, 'There is no active season. Start a new season first.');

    if (action === 'close_season') {
      const { error } = await supabase
        .from('cwl_seasons')
        .update({ status: 'closed', closed_by: actor, closed_at: now })
        .eq('id', season.id);
      if (error) throw new Error(error.message);
      if (body.clear_assignments === true) await clearAssignments();
      send(res, 200, { ok: true });
      return;
    }

    if (action === 'rename_season') {
      const name = cleanName(body.name);
      if (!name || name.length > 60) return fail(400, 'Season name is required (max 60 characters).');
      const { error } = await supabase.from('cwl_seasons').update({ name }).eq('id', season.id);
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true });
      return;
    }

    const findSeasonClan = async (tag: string) => {
      const { data, error } = await supabase
        .from('cwl_season_clans')
        .select('*')
        .eq('season_id', season.id)
        .eq('clan_tag', tag)
        .is('removed_at', null)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as { id: string; clan_tag: string; roster_size: number } | null;
    };
    const assignedCount = async (tag: string) => {
      const { count, error } = await supabase
        .from('cwl_entries')
        .select('id', { count: 'exact', head: true })
        .eq('cwl_clan_tag', tag);
      if (error) throw new Error(error.message);
      return count ?? 0;
    };

    if (action === 'update_clans') {
      const toTags = (value: unknown): string[] =>
        [...new Set((Array.isArray(value) ? value : []).map((item) => normTag(item)))];
      const addTags = toTags(body.add);
      const removeTags = toTags(body.remove);
      if (addTags.length === 0 && removeTags.length === 0) return fail(400, 'No changes to apply.');
      if (addTags.some((t) => removeTags.includes(t))) return fail(400, 'A clan cannot be added and removed at once.');

      const { data: current, error: currentError } = await supabase
        .from('cwl_season_clans')
        .select('clan_tag')
        .eq('season_id', season.id)
        .is('removed_at', null);
      if (currentError) throw new Error(currentError.message);
      const currentTags = new Set((current ?? []).map((row) => row.clan_tag as string));
      const newAdds = addTags.filter((t) => !currentTags.has(t));
      const realRemoves = removeTags.filter((t) => currentTags.has(t));

      if (newAdds.length > 0) {
        const { data: clans, error: clansError } = await supabase
          .from('cwl_clans')
          .select('clan_tag, cwl_league')
          .in('clan_tag', newAdds);
        if (clansError) throw new Error(clansError.message);
        if ((clans ?? []).length !== newAdds.length) return fail(400, 'One of the selected clans is not a CWL clan.');
        const { data: prevRoles } = await supabase
          .from('cwl_season_clans')
          .select('clan_tag, role_id, added_at')
          .in('clan_tag', newAdds)
          .not('role_id', 'is', null)
          .order('added_at', { ascending: false });
        const lastRoleByTag = new Map<string, string>();
        for (const r of prevRoles ?? []) {
          if (r.clan_tag && r.role_id && !lastRoleByTag.has(r.clan_tag as string)) {
            lastRoleByTag.set(r.clan_tag as string, r.role_id as string);
          }
        }
        const rows = (clans ?? []).map((clan) => {
          const league = String(clan.cwl_league ?? '').toLowerCase();
          return {
            season_id: season.id,
            clan_tag: clan.clan_tag,
            roster_size: !league || league.includes('unrank') ? 15 : 30,
            role_id: lastRoleByTag.get(clan.clan_tag as string) ?? null,
            added_by: actor,
          };
        });
        const { error } = await supabase.from('cwl_season_clans').insert(rows);
        if (error) throw new Error(error.message);
      }
      if (realRemoves.length > 0) {
        const { error } = await supabase
          .from('cwl_season_clans')
          .update({ removed_at: now, removed_by: actor })
          .eq('season_id', season.id)
          .in('clan_tag', realRemoves)
          .is('removed_at', null);
        if (error) throw new Error(error.message);
        const { error: unassignError } = await supabase
          .from('cwl_entries')
          .update({ cwl_clan_tag: null, cwl_clan_name: null })
          .in('cwl_clan_tag', realRemoves);
        if (unassignError) throw new Error(unassignError.message);
      }
      send(res, 200, { ok: true, added: newAdds.length, removed: realRemoves.length });
      return;
    }

    if (action === 'unassign') {
      const entryId = String(body.entry_id ?? '');
      if (!entryId) return fail(400, 'entry_id is required.');
      const { error } = await supabase
        .from('cwl_entries')
        .update({ cwl_clan_tag: null, cwl_clan_name: null })
        .eq('id', entryId);
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true });
      return;
    }

    const tag = normTag(body.clan_tag);
    if (!body.clan_tag) return fail(400, 'clan_tag is required.');

    if (action === 'add_clan') {
      const { data: clan, error: clanError } = await supabase
        .from('cwl_clans')
        .select('clan_tag, cwl_league')
        .eq('clan_tag', tag)
        .maybeSingle();
      if (clanError) throw new Error(clanError.message);
      if (!clan) return fail(400, 'Unknown CWL clan.');
      if (await findSeasonClan(tag)) return fail(400, 'That clan is already part of this season.');
      const { data: prevRole } = await supabase
        .from('cwl_season_clans')
        .select('role_id')
        .eq('clan_tag', tag)
        .not('role_id', 'is', null)
        .order('added_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const league = String(clan.cwl_league ?? '').toLowerCase();
      const size = !league || league.includes('unrank') ? 15 : 30;
      const { error } = await supabase
        .from('cwl_season_clans')
        .insert({
          season_id: season.id,
          clan_tag: tag,
          roster_size: size,
          role_id: (prevRole?.role_id as string | null) ?? null,
          added_by: actor,
        });
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true });
      return;
    }

    const seasonClan = await findSeasonClan(tag);
    if (!seasonClan) return fail(400, 'That clan is not part of the active season.');

    if (action === 'remove_clan') {
      const { error } = await supabase
        .from('cwl_season_clans')
        .update({ removed_at: now, removed_by: actor })
        .eq('id', seasonClan.id);
      if (error) throw new Error(error.message);
      const { error: unassignError } = await supabase
        .from('cwl_entries')
        .update({ cwl_clan_tag: null, cwl_clan_name: null })
        .eq('cwl_clan_tag', tag);
      if (unassignError) throw new Error(unassignError.message);
      send(res, 200, { ok: true });
      return;
    }

    if (action === 'set_size') {
      const size = Number(body.roster_size);
      if (size !== 15 && size !== 30) return fail(400, 'Roster size must be 15 or 30.');
      const count = await assignedCount(tag);
      if (count > size) return fail(400, `This clan has ${count} players assigned. Unassign ${count - size} before switching to a ${size}-player roster.`);
      const { error } = await supabase.from('cwl_season_clans').update({ roster_size: size }).eq('id', seasonClan.id);
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true });
      return;
    }

    if (action === 'set_role') {
      const rawRole = typeof body.role_id === 'string' ? body.role_id.trim() : '';
      const roleId = rawRole || null;
      const { error } = await supabase.from('cwl_season_clans').update({ role_id: roleId }).eq('id', seasonClan.id);
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true, role_id: roleId });
      return;
    }

    if (action === 'assign' || action === 'autofill' || action === 'assign_many') {
      const ids = action === 'assign'
        ? [String(body.entry_id ?? '')].filter(Boolean)
        : [...new Set((Array.isArray(body.entry_ids) ? body.entry_ids : []).map((id) => String(id)).filter(Boolean))];
      if (ids.length === 0) return fail(400, 'No players selected.');
      const count = await assignedCount(tag);
      if (count + ids.length > seasonClan.roster_size) {
        return fail(400, `Roster limit is ${seasonClan.roster_size}; this clan has ${count} assigned and only ${Math.max(0, seasonClan.roster_size - count)} slot(s) left.`);
      }
      const { data: clan, error: clanError } = await supabase
        .from('cwl_clans')
        .select('clan_name')
        .eq('clan_tag', tag)
        .maybeSingle();
      if (clanError) throw new Error(clanError.message);
      const base = Date.now();
      // Run in parallel; each row gets its own timestamp so the roster keeps the chosen order.
      const results = await Promise.all(ids.map((entryId, i) =>
        supabase
          .from('cwl_entries')
          .update({
            cwl_clan_tag: tag,
            cwl_clan_name: clan?.clan_name ?? null,
            cwl_assigned_at: new Date(base + i).toISOString(),
          })
          .eq('id', entryId)
          .is('cwl_clan_tag', null)
          .select('id')
      ));
      let assigned = 0;
      for (const { data, error } of results) {
        if (error) throw new Error(error.message);
        assigned += data?.length ?? 0;
      }
      if (assigned === 0) return fail(409, 'Those players were already assigned. Refresh and try again.');
      send(res, 200, { ok: true, assigned, skipped: ids.length - assigned });
      return;
    }

    fail(400, 'Unknown action.');
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Request failed.' });
  }
}

// GET/PATCH/DELETE /api/cwl-entries — CWL sign-ups list (cwl_entries_view + linked_players Discord IDs)
async function handleCwlEntries(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, auth: AuthResult): Promise<void> {
  const method = req.method ?? 'GET';
  if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
    send(res, 405, { ok: false, error: 'Use GET, PATCH or DELETE.' });
    return;
  }
  if (!auth.ok) {
    send(res, 401, { ok: false, error: 'Unauthorized.' });
    return;
  }
  const normTag = (tag: unknown): string => `#${String(tag ?? '').trim().toUpperCase().replace(/^#+/, '')}`;
  try {
    const supabase = adminClient();
    if (method === 'GET') {
      const [{ data, error }, { data: rawEntries }] = await Promise.all([
        supabase.from('cwl_entries_view').select('*').order('created_date', { ascending: true }),
        supabase.from('cwl_entries').select('id, status, current_clan, cwl_assigned_at'),
      ]);
      if (error) throw new Error(error.message);
      const rawById = new Map((rawEntries ?? []).map((row) => [row.id as string, row as { status?: string | null; current_clan?: string | null; cwl_assigned_at?: string | null }]));
      const entries = data ?? [];
      const lookup = new Set<string>();
      for (const entry of entries) {
        const n = normTag(entry.player_tag);
        lookup.add(n);
        lookup.add(n.slice(1));
      }
      const discordMap = new Map<string, string>();
      let warning: string | null = null;
      try {
        const playerbase = playerbaseAdminClient();
        const list = [...lookup];
        for (let i = 0; i < list.length; i += 200) {
          const { data: linked, error: linkedError } = await playerbase
            .from('linked_players')
            .select('player_tag, discord_id')
            .in('player_tag', list.slice(i, i + 200));
          if (linkedError) throw new Error(linkedError.message);
          for (const item of linked ?? []) {
            const key = normTag(item.player_tag);
            const id = item.discord_id != null ? String(item.discord_id).trim() : '';
            if (id && !discordMap.has(key)) discordMap.set(key, id);
          }
        }
      } catch (lookupError) {
        warning = `Discord ID lookup failed: ${lookupError instanceof Error ? lookupError.message : 'unknown error'}`;
      }
      send(res, 200, {
        ok: true,
        warning,
        entries: entries.map((entry) => {
          const extra = rawById.get(entry.id as string);
          return {
            ...entry,
            status: entry.status ?? extra?.status ?? null,
            current_clan: entry.current_clan ?? extra?.current_clan ?? null,
            cwl_assigned_at: entry.cwl_assigned_at ?? extra?.cwl_assigned_at ?? null,
            discord_id: discordMap.get(normTag(entry.player_tag)) ?? null,
          };
        }),
      });
      return;
    }

    const body = readJsonBody(req);
    const id = String(body.id ?? '');
    if (!id) {
      send(res, 400, { ok: false, error: 'id is required.' });
      return;
    }
    if (method === 'DELETE') {
      const { error } = await supabase.from('cwl_entries').delete().eq('id', id);
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true });
      return;
    }

    const updates: Record<string, unknown> = {};
    if ('notes' in body) {
      const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
      updates.notes = notes || null;
    }
    let parsedWeight: number | null | undefined;
    if ('war_weight' in body) {
      if (body.war_weight === null || body.war_weight === '') {
        parsedWeight = null;
      } else {
        const weight = Number(body.war_weight);
        if (!Number.isInteger(weight) || weight < 0) {
          send(res, 400, { ok: false, error: 'War weight must be a non-negative whole number.' });
          return;
        }
        parsedWeight = weight;
      }
    }
    if ('cwl_clan_tag' in body) {
      const rawTag = typeof body.cwl_clan_tag === 'string' ? body.cwl_clan_tag.trim() : '';
      if (!rawTag) {
        updates.cwl_clan_tag = null;
        updates.cwl_clan_name = null;
      } else {
        const tag = normTag(rawTag);
        const { data: clan, error: clanError } = await supabase
          .from('cwl_clans')
          .select('clan_tag, clan_name')
          .eq('clan_tag', tag)
          .maybeSingle();
        if (clanError) throw new Error(clanError.message);
        if (!clan) {
          send(res, 400, { ok: false, error: 'Unknown CWL clan.' });
          return;
        }
        updates.cwl_clan_tag = clan.clan_tag;
        updates.cwl_clan_name = clan.clan_name;
      }
    }
    if (parsedWeight !== undefined) {
      const { data: entry, error: entryError } = await supabase
        .from('cwl_entries')
        .select('player_tag')
        .eq('id', id)
        .maybeSingle();
      if (entryError) throw new Error(entryError.message);
      if (!entry) {
        send(res, 404, { ok: false, error: 'CWL entry not found.' });
        return;
      }
      const tag = normTag(entry.player_tag);
      const tagVariants = [tag, tag.slice(1)];
      const now = new Date().toISOString();

      const { data: cpUpdated, error: cpError } = await supabase
        .from('clan_players')
        .update({ war_weight: parsedWeight, updated_date: now })
        .in('player_tag', tagVariants)
        .select('id');
      if (cpError) throw new Error(cpError.message);

      const { error: wwError } = await supabase
        .from('war_weights')
        .update({
          war_weight: parsedWeight,
          value: parsedWeight !== null ? Math.round(parsedWeight / 5) : null,
          updated_date: now,
        })
        .in('player_tag', tagVariants);
      if (wwError) throw new Error(wwError.message);

      // Keep override in sync only when the player isn't in clan_players (or clear it when clearing weight)
      if (!cpUpdated?.length || parsedWeight === null) {
        updates.war_weight_override = parsedWeight;
      }
    }
    if (Object.keys(updates).length > 0) {
      const { error } = await supabase.from('cwl_entries').update(updates).eq('id', id);
      if (error) throw new Error(error.message);
    } else if (parsedWeight === undefined) {
      send(res, 400, { ok: false, error: 'Nothing to update.' });
      return;
    }
    send(res, 200, { ok: true });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Request failed.' });
  }
}

const CWL_SETTING_KEYS = ['cwl_signup_enabled', 'cwl_roster_enabled', 'cwl_tracker_enabled'] as const;
type CwlSettingKey = (typeof CWL_SETTING_KEYS)[number];

// GET/POST /api/cwl-signup-settings — CWL switches (bot_settings in playerbase DB)
async function handleCwlSignupSettings(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, auth: AuthResult): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use GET or POST.' });
    return;
  }
  if (!auth.ok) {
    send(res, 401, { ok: false, error: 'Unauthorized.' });
    return;
  }
  try {
    const playerbase = playerbaseAdminClient();
    if (method === 'POST') {
      const body = readJsonBody(req);
      const rawKey = typeof body.setting_name === 'string' && body.setting_name.trim()
        ? body.setting_name.trim()
        : 'cwl_signup_enabled';
      if (!CWL_SETTING_KEYS.includes(rawKey as CwlSettingKey)) {
        send(res, 400, { ok: false, error: `Invalid setting_name. Must be one of: ${CWL_SETTING_KEYS.join(', ')}.` });
        return;
      }
      if (typeof body.enabled !== 'boolean') {
        send(res, 400, { ok: false, error: '"enabled" must be a boolean.' });
        return;
      }
      const { error } = await playerbase
        .from('bot_settings')
        .upsert({ setting_name: rawKey, setting_value: body.enabled ? 'true' : 'false' }, { onConflict: 'setting_name' });
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true, setting_name: rawKey, enabled: body.enabled });
      return;
    }
    const { data, error } = await playerbase
      .from('bot_settings')
      .select('setting_name, setting_value')
      .in('setting_name', [...CWL_SETTING_KEYS]);
    if (error) throw new Error(error.message);
    const byKey = new Map<string, boolean>();
    for (const row of data ?? []) {
      const key = String(row.setting_name ?? '').trim();
      const val = String(row.setting_value ?? '').trim().toLowerCase() === 'true';
      byKey.set(key, val);
    }
    const cwl_signup_enabled = byKey.get('cwl_signup_enabled') ?? false;
    const cwl_roster_enabled = byKey.get('cwl_roster_enabled') ?? false;
    const cwl_tracker_enabled = byKey.get('cwl_tracker_enabled') ?? false;
    send(res, 200, {
      ok: true,
      enabled: cwl_signup_enabled,
      cwl_signup_enabled,
      cwl_roster_enabled,
      cwl_tracker_enabled,
    });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Request failed.' });
  }
}

// POST/DELETE /api/cwl-clans — CWL clans directory
async function handleCwlClans(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, auth: AuthResult): Promise<void> {
  const method = req.method ?? 'POST';
  if (method !== 'POST' && method !== 'DELETE') {
    send(res, 405, { ok: false, error: 'Use POST to add, DELETE to remove.' });
    return;
  }
  if (!isDeveloper(auth)) {
    send(res, 403, { ok: false, error: 'Developer role required.' });
    return;
  }

  const body = readJsonBody(req);

  if (method === 'POST' && body.refresh_all === true) {
    try {
      const supabase = adminClient();
      const { data: rows, error: selectError } = await supabase.from('cwl_clans').select('clan_tag');
      if (selectError) throw new Error(selectError.message);
      const tags = (rows ?? []).map((row) => row.clan_tag as string);
      let refreshed = 0;
      const errors: string[] = [];
      for (const clanTag of tags) {
        try {
          const clan = await getClan(clanTag);
          const leader = clan.memberList?.find((m) => m.role === 'leader') ?? null;
          const row = {
            clan_tag: clan.tag,
            clan_name: clan.name,
            cwl_league: clan.warLeague?.name ?? null,
            leader_name: leader?.name ?? null,
            badge_url: clan.badgeUrls?.large ?? clan.badgeUrls?.medium ?? clan.badgeUrls?.small ?? null,
          };
          const { error: upsertError } = await supabase.from('cwl_clans').upsert(row, { onConflict: 'clan_tag' });
          if (upsertError) throw new Error(upsertError.message);
          refreshed++;
        } catch (error) {
          if (errors.length < 10) {
            errors.push(`${clanTag}: ${(error as Error).message.slice(0, 120)}`);
          }
        }
      }
      send(res, 200, { ok: true, refreshed, total: tags.length, errors });
      return;
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Refresh failed.' });
      return;
    }
  }

  const rawTag = String(body.clan_tag ?? '');
  if (!rawTag) {
    send(res, 400, { ok: false, error: 'Provide a valid clan tag.' });
    return;
  }

  try {
    const supabase = adminClient();
    // cwl_clans is standalone: normalize the tag only, never touch family_clans
    const cleaned = rawTag.trim().toUpperCase().replace(/^#+/, '');
    const tag = `#${cleaned}`;
    if (method === 'DELETE') {
      const { error } = await supabase.from('cwl_clans').delete().eq('clan_tag', tag);
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true, deleted: tag });
      return;
    }

    let clan;
    try {
      clan = await getClan(tag);
    } catch (error) {
      if (error instanceof CocNotFound) {
        send(res, 404, { ok: false, error: `No clan found for ${tag}. Check the tag.` });
        return;
      }
      throw error;
    }

    const leader = clan.memberList?.find((m) => m.role === 'leader') ?? null;
    const row = {
      clan_tag: clan.tag,
      clan_name: clan.name,
      cwl_league: clan.warLeague?.name ?? null,
      leader_name: leader?.name ?? null,
      badge_url: clan.badgeUrls?.large ?? clan.badgeUrls?.medium ?? clan.badgeUrls?.small ?? null,
    };
    const { error: upsertError } = await supabase.from('cwl_clans').upsert(row, { onConflict: 'clan_tag' });
    if (upsertError) throw new Error(upsertError.message);
    send(res, 200, { ok: true, clan: row });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Request failed.' });
  }
}

/* ───────────────────── Strike system handlers ───────────────────── */

// GET /api/strike-config?type=global — list global strike reasons (each with value)
// POST /api/strike-config?type=global — save global strike reason+value (Developer)
async function handleStrikeConfigGlobal(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  const supabase = adminClient();
  if (req.method === 'GET') {
    // GET is available to all authenticated users (not just developers)
    if (!auth.ok) {
      send(res, 401, { ok: false, error: auth.message });
      return;
    }
    const { data: reasons, error: rError } = await supabase
      .from('strike_reasons_global')
      .select('*')
      .order('reason_text', { ascending: true });
    if (rError) {
      send(res, 500, { ok: false, error: rError.message || 'Failed to load strike config.' });
      return;
    }
    send(res, 200, { ok: true, reasons: reasons ?? [] });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use GET or POST.' });
    return;
  }
  const body = readJsonBody(req);
  // POST requires Developer role
  if (!isDeveloper(auth)) {
    send(res, 403, { ok: false, error: 'Developer role required.' });
    return;
  }
  const action = String(body.action ?? '');
  if (action === 'save_reason') {
    const id = String(body.id ?? '');
    const value = body.value;
    const reason_text = String(body.reason_text ?? '').trim();
    const is_active = body.is_active ?? true;
    if (!reason_text || value === null || value === undefined) {
      send(res, 400, { ok: false, error: 'Value and reason text are required.' });
      return;
    }
    try {
      if (id) {
        const { error } = await supabase
          .from('strike_reasons_global')
          .update({ value, reason_text, is_active, updated_at: new Date().toISOString() })
          .eq('id', id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase
          .from('strike_reasons_global')
          .insert({ value, reason_text, is_active });
        if (error) throw new Error(error.message);
      }
      send(res, 200, { ok: true });
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Save failed.' });
    }
    return;
  }
  if (action === 'delete_reason') {
    const id = String(body.id ?? '');
    if (!id) {
      send(res, 400, { ok: false, error: 'ID is required.' });
      return;
    }
    try {
      const { error } = await supabase.from('strike_reasons_global').delete().eq('id', id);
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true });
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Delete failed.' });
    }
    return;
  }
  send(res, 400, { ok: false, error: 'Unknown strike config action.' });
}

// GET /api/strike-config/clan?clan_tag=#TAG — per-clan overrides + custom
// POST /api/strike-config/clan — save per-clan overrides (Developer)
async function handleStrikeConfigClan(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  const supabase = adminClient();
  if (req.method === 'GET') {
    // GET is available to all authenticated users
    if (!auth.ok) {
      send(res, 401, { ok: false, error: auth.message });
      return;
    }
    const q = getQuery(req);
    const clanTag = q.clan_tag ?? '';
    if (!clanTag) {
      send(res, 400, { ok: false, error: 'Clan tag is required.' });
      return;
    }
    try {
      const resolvedTag = await resolveClanTag(supabase, clanTag);
      const [{ data: overrides, error: oError }, { data: custom, error: cError }] = await Promise.all([
        supabase.from('clan_strike_overrides').select('*').eq('clan_tag', resolvedTag),
        supabase.from('clan_strike_custom').select('*').eq('clan_tag', resolvedTag).order('reason_text', { ascending: true }),
      ]);
      if (oError || cError) {
        send(res, 500, { ok: false, error: (oError || cError)?.message || 'Failed to load clan strike config.' });
        return;
      }
      send(res, 200, { ok: true, clan_tag: resolvedTag, overrides: overrides ?? [], custom: custom ?? [] });
      return;
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Failed to load clan strike config.' });
      return;
    }
  }
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use GET or POST.' });
    return;
  }
  // POST requires Developer role
  if (!isDeveloper(auth)) {
    send(res, 403, { ok: false, error: 'Developer role required.' });
    return;
  }
  const body = readJsonBody(req);
  const action = String(body.action ?? '');
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  if (!clanTagRaw) {
    send(res, 400, { ok: false, error: 'Clan tag is required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    if (action === 'save_override') {
      const id = String(body.id ?? '');
      const global_reason_id = String(body.global_reason_id ?? '');
      const is_enabled = body.is_enabled ?? true;
      const custom_reason_text = String(body.custom_reason_text ?? '').trim() || null;
      const custom_value = body.custom_value ?? null;
      try {
        if (id) {
          const { error } = await supabase
            .from('clan_strike_overrides')
            .update({ global_reason_id, is_enabled, custom_reason_text, custom_value, updated_at: new Date().toISOString() })
            .eq('id', id);
          if (error) throw new Error(error.message);
        } else {
          const { error } = await supabase
            .from('clan_strike_overrides')
            .insert({ clan_tag: clanTag, global_reason_id, is_enabled, custom_reason_text, custom_value });
          if (error) throw new Error(error.message);
        }
        send(res, 200, { ok: true });
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Save failed.' });
      }
      return;
    }
    if (action === 'save_custom') {
      const id = String(body.id ?? '');
      const value = body.value;
      const reason_text = String(body.reason_text ?? '').trim();
      const is_active = body.is_active ?? true;
      if (!reason_text || value === null || value === undefined) {
        send(res, 400, { ok: false, error: 'Value and reason text are required.' });
        return;
      }
      try {
        if (id) {
          const { error } = await supabase
            .from('clan_strike_custom')
            .update({ value, reason_text, is_active, created_at: new Date().toISOString() })
            .eq('id', id);
          if (error) throw new Error(error.message);
        } else {
          const { error } = await supabase
            .from('clan_strike_custom')
            .insert({ clan_tag: clanTag, value, reason_text, is_active });
          if (error) throw new Error(error.message);
        }
        send(res, 200, { ok: true });
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Save failed.' });
      }
      return;
    }
    if (action === 'delete_override') {
      const id = String(body.id ?? '');
      if (!id) {
        send(res, 400, { ok: false, error: 'ID is required.' });
        return;
      }
      try {
        const { error } = await supabase.from('clan_strike_overrides').delete().eq('id', id);
        if (error) throw new Error(error.message);
        send(res, 200, { ok: true });
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Delete failed.' });
      }
      return;
    }
    if (action === 'delete_custom') {
      const id = String(body.id ?? '');
      if (!id) {
        send(res, 400, { ok: false, error: 'ID is required.' });
        return;
      }
      try {
        const { error } = await supabase.from('clan_strike_custom').delete().eq('id', id);
        if (error) throw new Error(error.message);
        send(res, 200, { ok: true });
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Delete failed.' });
      }
      return;
    }
    send(res, 400, { ok: false, error: 'Unknown strike config action.' });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Failed to process strike config.' });
  }
}

// GET /api/strikes/pending?clan_tag=#TAG — pending strikes for a clan
// POST /api/strikes/pending — add pending strike(s) (batch)
async function handleStrikesPending(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (auth.ok === false) {
    send(res, 401, { ok: false, error: auth.message });
    return;
  }
  const supabase = adminClient();
  if (req.method === 'GET') {
    const q = getQuery(req);
    const clanTag = q.clan_tag ?? '';
    if (!clanTag) {
      send(res, 400, { ok: false, error: 'Clan tag is required.' });
      return;
    }
    try {
      const resolvedTag = await resolveClanTag(supabase, clanTag);
      const { data, error } = await supabase
        .from('strikes_pending')
        .select('*')
        .eq('clan_tag', resolvedTag)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true, clan_tag: resolvedTag, strikes: data ?? [] });
      return;
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Failed to load pending strikes.' });
      return;
    }
  }
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use GET or POST.' });
    return;
  }
  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const strikes = Array.isArray(body.strikes) ? body.strikes : [];
  if (!clanTagRaw || strikes.length === 0) {
    send(res, 400, { ok: false, error: 'Clan tag and at least one strike are required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    const now = new Date().toISOString();
    const rows = strikes.map((s: Record<string, unknown>) => ({
      clan_tag: clanTag,
      player_tag: String(s.player_tag ?? ''),
      player_name: String(s.player_name ?? ''),
      discord_id: String(s.discord_id ?? '') || null,
      value: Number(s.value ?? 0),
      reason: String(s.reason ?? ''),
      note: String(s.note ?? '') || null,
      issued_date: String(s.issued_date ?? now),
      issued_by: String(s.issued_by ?? ''),
      created_at: now,
    }));
    const { error } = await supabase.from('strikes_pending').insert(rows);
    if (error) throw new Error(error.message);
    send(res, 200, { ok: true, inserted: rows.length });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Failed to add pending strikes.' });
  }
}

// POST /api/strikes/confirm — confirm pending strikes (batch)
async function handleStrikesConfirm(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (auth.ok === false) {
    send(res, 401, { ok: false, error: auth.message });
    return;
  }
  const body = readJsonBody(req);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const confirmed_by = String(body.confirmed_by ?? '');
  if (ids.length === 0 || !confirmed_by) {
    send(res, 400, { ok: false, error: 'Strike IDs and confirmed_by are required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const now = new Date().toISOString();
    // Fetch pending strikes to confirm
    const { data: pending, error: fetchError } = await supabase
      .from('strikes_pending')
      .select('*')
      .in('id', ids);
    if (fetchError) throw new Error(fetchError.message);
    if (!pending || pending.length === 0) {
      send(res, 404, { ok: false, error: 'No pending strikes found.' });
      return;
    }
    // Insert into confirmed
    const confirmedRows = pending.map((p) => ({
      clan_tag: p.clan_tag,
      player_tag: p.player_tag,
      player_name: p.player_name,
      discord_id: p.discord_id,
      value: p.value,
      reason: p.reason,
      note: p.note,
      issued_date: p.issued_date,
      confirmed_date: now,
      confirmed_by,
      is_active: true,
      season: null,
      created_at: now,
      updated_at: now,
    }));
    const { error: insertError } = await supabase.from('strikes_confirmed').insert(confirmedRows);
    if (insertError) throw new Error(insertError.message);
    // Delete from pending
    const { error: deleteError } = await supabase.from('strikes_pending').delete().in('id', ids);
    if (deleteError) throw new Error(deleteError.message);
    send(res, 200, { ok: true, confirmed: confirmedRows.length });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Confirm failed.' });
  }
}

// GET /api/strikes/confirmed?clan_tag=#TAG — confirmed strikes for a clan
async function handleStrikesConfirmed(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined> },
  res: { status: (code: number) => { json: (body: unknown) => void } }
): Promise<void> {
  if (req.method !== 'GET') {
    send(res, 405, { ok: false, error: 'Use GET.' });
    return;
  }
  const q = getQuery(req);
  const clanTag = q.clan_tag ?? '';
  if (!clanTag) {
    send(res, 400, { ok: false, error: 'Clan tag is required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const resolvedTag = await resolveClanTag(supabase, clanTag);
    const [{ data, error }, roster] = await Promise.all([
      supabase
        .from('strikes_confirmed')
        .select('*')
        .eq('clan_tag', resolvedTag)
        .eq('is_active', true)
        .order('issued_date', { ascending: false }),
      // Current website roster for this clan — lets the Strike Board push
      // players who are no longer on the roster to the bottom.
      supabase
        .from('clan_players')
        .select('player_tag')
        .eq('clan_tag', resolvedTag),
    ]);
    if (error) throw new Error(error.message);
    send(res, 200, {
      ok: true,
      clan_tag: resolvedTag,
      strikes: data ?? [],
      // null = roster could not be loaded (client then treats everyone as current)
      roster_tags: roster.error ? null : (roster.data ?? []).map((p) => p.player_tag),
    });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Failed to load confirmed strikes.' });
  }
}

// POST /api/strikes/resolve — remove/resolve a confirmed strike
async function handleStrikesResolve(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (auth.ok === false) {
    send(res, 401, { ok: false, error: auth.message });
    return;
  }
  const body = readJsonBody(req);
  const id = String(body.id ?? '');
  if (!id) {
    send(res, 400, { ok: false, error: 'Strike ID is required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const { error } = await supabase.from('strikes_confirmed').delete().eq('id', id);
    if (error) throw new Error(error.message);
    send(res, 200, { ok: true });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Resolve failed.' });
  }
}

// POST /api/strikes/reduce — add a reduction entry (-1 value) for players
async function handleStrikesReduce(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (auth.ok === false) {
    send(res, 401, { ok: false, error: auth.message });
    return;
  }
  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const reason = String(body.reason ?? '').trim();
  const playerTags = Array.isArray(body.player_tags) ? body.player_tags : [];
  const issued_by = String(body.issued_by ?? '');
  const season = String(body.season ?? '').trim() || null;
  if (!clanTagRaw || !reason || !issued_by) {
    send(res, 400, { ok: false, error: 'Clan tag, reason, and issued_by are required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    const now = new Date().toISOString();

    // Determine target players
    let targets: string[] = playerTags;
    if (targets.length === 0) {
      const { data: activeStrikes, error: strikeError } = await supabase
        .from('strikes_confirmed')
        .select('player_tag')
        .eq('clan_tag', clanTag)
        .eq('is_active', true);
      if (strikeError) throw new Error(strikeError.message);
      targets = [...new Set((activeStrikes ?? []).map((s) => s.player_tag))];
    }

    // Fetch current totals per player so we can cap reduction at 0
    // Also fetch player_name and discord_id so reduction rows carry them
    const { data: allStrikes, error: totalsError } = await supabase
      .from('strikes_confirmed')
      .select('player_tag, value, player_name, discord_id')
      .eq('clan_tag', clanTag)
      .eq('is_active', true)
      .order('issued_date', { ascending: false });
    if (totalsError) throw new Error(totalsError.message);

    const playerTotals = new Map<string, number>();
    const playerInfo = new Map<string, { player_name: string; discord_id: string | null }>();
    for (const s of (allStrikes ?? [])) {
      const current = playerTotals.get(s.player_tag) ?? 0;
      playerTotals.set(s.player_tag, current + (s.value ?? 0));
      // Store the first (most recent) non-empty player_name / discord_id per player
      if (!playerInfo.has(s.player_tag) && s.player_name && s.player_name.trim()) {
        playerInfo.set(s.player_tag, {
          player_name: s.player_name,
          discord_id: s.discord_id ?? null,
        });
      }
    }

    const rows = [];
    for (const tag of targets) {
      const currentTotal = playerTotals.get(String(tag)) ?? 0;
      // Cap reduction at 0 — never let total go below 0
      const reduction = Math.min(1, currentTotal);
      if (reduction <= 0) continue;

      const info = playerInfo.get(String(tag)) ?? { player_name: '', discord_id: null };

      rows.push({
        clan_tag: clanTag,
        player_tag: String(tag),
        player_name: info.player_name,
        discord_id: info.discord_id,
        value: -reduction,
        reason,
        note: null,
        issued_date: now,
        confirmed_date: now,
        confirmed_by: issued_by,
        is_active: true,
        season,
        created_at: now,
        updated_at: now,
      });
    }

    if (rows.length === 0) {
      send(res, 200, { ok: true, inserted: 0, message: 'No players needed reduction' });
      return;
    }

    const { error } = await supabase.from('strikes_confirmed').insert(rows);
    if (error) throw new Error(error.message);
    send(res, 200, { ok: true, inserted: rows.length });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Reduce failed.' });
  }
}

// POST /api/strikes?action=confirm_batch — insert strikes directly into confirmed table
async function handleStrikesConfirmBatch(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (auth.ok === false) {
    send(res, 401, { ok: false, error: auth.message });
    return;
  }
  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  const strikes = Array.isArray(body.strikes) ? body.strikes : [];
  if (!clanTagRaw || strikes.length === 0) {
    send(res, 400, { ok: false, error: 'Clan tag and at least one strike are required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    const now = new Date().toISOString();
    const confirmedBy = String(body.confirmed_by ?? '');
    const rows = strikes.map((s: Record<string, unknown>) => ({
      clan_tag: clanTag,
      player_tag: String(s.player_tag ?? ''),
      player_name: String(s.player_name ?? ''),
      discord_id: String(s.discord_id ?? '') || null,
      value: Number(s.value ?? 0),
      reason: String(s.reason ?? ''),
      note: String(s.note ?? '') || null,
      issued_date: String(s.issued_date ?? now),
      confirmed_date: now,
      confirmed_by: confirmedBy,
      is_active: true,
      season: null,
      created_at: now,
      updated_at: now,
    }));
    const { error } = await supabase.from('strikes_confirmed').insert(rows);
    if (error) throw new Error(error.message);
    // Also delete from pending strikes for this clan since they are now confirmed
    await supabase.from('strikes_pending').delete().eq('clan_tag', clanTag);
    send(res, 200, { ok: true, confirmed: rows.length });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Confirm batch failed.' });
  }
}

// POST /api/strikes?action=clear_pending — delete all pending strikes for a clan
async function handleStrikesClearPending(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (auth.ok === false) {
    send(res, 401, { ok: false, error: auth.message });
    return;
  }
  const body = readJsonBody(req);
  const clanTagRaw = String(body.clan_tag ?? '').trim();
  if (!clanTagRaw) {
    send(res, 400, { ok: false, error: 'Clan tag is required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    const { error } = await supabase.from('strikes_pending').delete().eq('clan_tag', clanTag);
    if (error) throw new Error(error.message);
    send(res, 200, { ok: true });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Clear pending failed.' });
  }
}

// POST /api/strikes?action=delete_pending — delete a single pending strike by id
async function handleStrikesDeletePending(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (auth.ok === false) {
    send(res, 401, { ok: false, error: auth.message });
    return;
  }
  const body = readJsonBody(req);
  const id = String(body.id ?? '');
  if (!id) {
    send(res, 400, { ok: false, error: 'Pending strike ID is required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const { error } = await supabase.from('strikes_pending').delete().eq('id', id);
    if (error) throw new Error(error.message);
    send(res, 200, { ok: true });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Delete pending failed.' });
  }
}

// POST /api/strikes?action=edit_pending — edit a pending strike (value 0 = warning)
async function handleStrikesEditPending(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (auth.ok === false) {
    send(res, 401, { ok: false, error: auth.message });
    return;
  }
  const body = readJsonBody(req);
  const id = String(body.id ?? '');
  const value = body.value;
  const reason = String(body.reason ?? '').trim();
  const note = String(body.note ?? '').trim() || null;
  const issued_date = String(body.issued_date ?? '');
  if (!id || !reason || value === null || value === undefined || value === '' || isNaN(Number(value)) || !issued_date) {
    send(res, 400, { ok: false, error: 'Strike ID, value, reason, and date are required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const { error } = await supabase
      .from('strikes_pending')
      .update({ value: Number(value), reason, note, issued_date })
      .eq('id', id);
    if (error) throw new Error(error.message);
    send(res, 200, { ok: true });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Edit pending failed.' });
  }
}

// POST /api/strikes?action=edit_strike — edit a confirmed strike
async function handleStrikesEdit(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (auth.ok === false) {
    send(res, 401, { ok: false, error: auth.message });
    return;
  }
  const body = readJsonBody(req);
  const id = String(body.id ?? '');
  const value = body.value;
  const reason = String(body.reason ?? '').trim();
  const note = String(body.note ?? '').trim() || null;
  const issued_date = String(body.issued_date ?? '');
  const edited_by = String(body.edited_by ?? '');
  if (!id || !reason || value === null || value === undefined || !issued_date || !edited_by) {
    send(res, 400, { ok: false, error: 'Strike ID, value, reason, date, and editor are required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const { error } = await supabase
      .from('strikes_confirmed')
      .update({
        value: Number(value),
        reason,
        note,
        issued_date,
        edited_by,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw new Error(error.message);
    send(res, 200, { ok: true });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Edit failed.' });
  }
}

// POST /api/strikes/reset — archive all confirmed strikes for a season
async function handleStrikesReset(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (!isDeveloper(auth)) {
    send(res, 403, { ok: false, error: 'Developer role required.' });
    return;
  }
  const body = readJsonBody(req);
  const season = String(body.season ?? '').trim();
  if (!season) {
    send(res, 400, { ok: false, error: 'Season name is required.' });
    return;
  }
  try {
    const supabase = adminClient();
    const { data: strikes, error: fetchError } = await supabase
      .from('strikes_confirmed')
      .select('*')
      .eq('is_active', true);
    if (fetchError) throw new Error(fetchError.message);
    if (!strikes || strikes.length === 0) {
      send(res, 200, { ok: true, archived: 0 });
      return;
    }
    const now = new Date().toISOString();
    const archiveRows = strikes.map((s) => ({
      original_id: s.id,
      clan_tag: s.clan_tag,
      player_tag: s.player_tag,
      player_name: s.player_name,
      discord_id: s.discord_id,
      value: s.value,
      reason: s.reason,
      note: s.note,
      issued_date: s.issued_date,
      confirmed_date: s.confirmed_date,
      confirmed_by: s.confirmed_by,
      season,
      archived_at: now,
    }));
    const { error: insertError } = await supabase.from('strikes_archive').insert(archiveRows);
    if (insertError) throw new Error(insertError.message);
    const { error: deactivateError } = await supabase
      .from('strikes_confirmed')
      .update({ is_active: false, season, updated_at: now })
      .eq('is_active', true);
    if (deactivateError) throw new Error(deactivateError.message);
    send(res, 200, { ok: true, archived: archiveRows.length });
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Reset failed.' });
  }
}

// GET /api/player-search?tag=#TAG — comprehensive player lookup from CoC API + Discord + Strikes
async function handlePlayerSearch(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined> },
  res: { status: (code: number) => { json: (body: unknown) => void } }
): Promise<void> {
  if (req.method && req.method !== 'GET') {
    send(res, 405, { ok: false, error: 'Use GET.' });
    return;
  }

  const q = getQuery(req);
  const rawTag = String(q.tag ?? '').trim();
  if (!rawTag) {
    send(res, 400, { ok: false, error: 'Player tag is required.' });
    return;
  }

  const cleanTag = rawTag.toUpperCase().replace(/^#+/, '').replace(/O/g, '0');
  if (!/^[0289CGJLPUVQRY]+$/.test(cleanTag) || cleanTag.length < 3) {
    send(res, 400, { ok: false, error: 'Invalid Clash of Clans player tag.' });
    return;
  }

  const playerTag = `#${cleanTag}`;
  const tagVariants = [playerTag, cleanTag];

  try {
    let profile;
    try {
      profile = await getPlayerProfile(playerTag);
    } catch (error) {
      if (error instanceof CocNotFound) {
        send(res, 404, { ok: false, error: `Player ${playerTag} not found in Clash of Clans.` });
        return;
      }
      if (error instanceof CocMaintenance) {
        send(res, 503, { ok: false, error: 'Clash of Clans API is currently under maintenance. Please try again later.' });
        return;
      }
      throw error;
    }

    const supabase = adminClient();

    // 1. Resolve Discord ID (from linked_players first, fallback to clan_players / strikes)
    let discordId: string | null = null;
    try {
      const playerbase = playerbaseAdminClient();
      const { data: linked } = await playerbase
        .from('linked_players')
        .select('player_tag, discord_id')
        .in('player_tag', tagVariants);
      for (const row of linked ?? []) {
        const id = row.discord_id != null ? String(row.discord_id).trim() : '';
        if (id) {
          discordId = id;
          break;
        }
      }
    } catch {
      // playerbase optional
    }

    // 2. Fetch strikes (current & past seasons) + family_clans + fallback discord_id
    const [
      { data: confirmedStrikes },
      { data: archivedStrikes },
      { data: familyClans },
      { data: rosterRows },
    ] = await Promise.all([
      supabase
        .from('strikes_confirmed')
        .select('id, clan_tag, player_tag, player_name, discord_id, value, reason, note, issued_date, confirmed_date, confirmed_by, edited_by, is_active, season')
        .in('player_tag', tagVariants)
        .order('issued_date', { ascending: false }),
      supabase
        .from('strikes_archive')
        .select('id, original_id, clan_tag, player_tag, player_name, discord_id, value, reason, note, issued_date, confirmed_date, confirmed_by, season, archived_at')
        .in('player_tag', tagVariants)
        .order('issued_date', { ascending: false }),
      supabase
        .from('family_clans')
        .select('clan_tag, clan_name'),
      supabase
        .from('clan_players')
        .select('discord_id')
        .in('player_tag', tagVariants),
    ]);

    if (!discordId) {
      for (const r of rosterRows ?? []) {
        const id = r.discord_id != null ? String(r.discord_id).trim() : '';
        if (id) {
          discordId = id;
          break;
        }
      }
    }
    if (!discordId) {
      for (const s of [...(confirmedStrikes ?? []), ...(archivedStrikes ?? [])]) {
        const id = s.discord_id != null ? String(s.discord_id).trim() : '';
        if (id) {
          discordId = id;
          break;
        }
      }
    }

    // 3. If Discord ID found, resolve live Discord profile (nickname, username, avatar)
    let discordProfile: {
      discord_id: string;
      nickname: string;
      username: string;
      avatar_url: string | null;
    } | null = null;

    if (discordId) {
      const stripDiscrim = (val: unknown): string =>
        typeof val === 'string' ? val.trim().replace(/#0$/, '') : '';
      let username = '';
      let nickname = '';
      let avatarUrl: string | null = null;
      const botToken = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
      const guildId = (process.env.DISCORD_GUILD_ID ?? '').trim() || CWL_DISCORD_GUILD_ID;

      if (botToken && /^\d{15,22}$/.test(discordId)) {
        let resolved = false;
        if (guildId) {
          try {
            const memberResp = await fetch(
              `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
              { headers: { Authorization: `Bot ${botToken}` } }
            );
            if (memberResp.ok) {
              const member = (await memberResp.json()) as Record<string, unknown>;
              const dUser = (member.user ?? {}) as Record<string, unknown>;
              const liveUsername = stripDiscrim(dUser.username);
              const liveGlobalName =
                typeof dUser.global_name === 'string' && dUser.global_name.trim()
                  ? dUser.global_name.trim()
                  : null;
              const liveNick =
                typeof member.nick === 'string' && member.nick.trim()
                  ? member.nick.trim()
                  : null;

              if (liveUsername) username = liveUsername;
              nickname = liveNick || liveGlobalName || liveUsername || discordId;

              const memberAvatar =
                typeof member.avatar === 'string' && member.avatar.trim()
                  ? member.avatar.trim()
                  : null;
              const userAvatar =
                typeof dUser.avatar === 'string' && dUser.avatar.trim()
                  ? dUser.avatar.trim()
                  : null;

              if (memberAvatar) {
                const ext = memberAvatar.startsWith('a_') ? 'gif' : 'png';
                avatarUrl = `https://cdn.discordapp.com/guilds/${guildId}/users/${discordId}/avatars/${memberAvatar}.${ext}?size=256`;
              } else if (userAvatar) {
                const ext = userAvatar.startsWith('a_') ? 'gif' : 'png';
                avatarUrl = `https://cdn.discordapp.com/avatars/${discordId}/${userAvatar}.${ext}?size=256`;
              }
              resolved = true;
            }
          } catch {
            // fallback to global user lookup
          }
        }

        if (!resolved) {
          try {
            const userResp = await fetch(`https://discord.com/api/v10/users/${discordId}`, {
              headers: { Authorization: `Bot ${botToken}` },
            });
            if (userResp.ok) {
              const dUser = (await userResp.json()) as Record<string, unknown>;
              const liveUsername = stripDiscrim(dUser.username);
              const liveGlobalName =
                typeof dUser.global_name === 'string' && dUser.global_name.trim()
                  ? dUser.global_name.trim()
                  : null;
              if (liveUsername) username = liveUsername;
              nickname = liveGlobalName || liveUsername || discordId;

              const userAvatar =
                typeof dUser.avatar === 'string' && dUser.avatar.trim()
                  ? dUser.avatar.trim()
                  : null;
              if (userAvatar) {
                const ext = userAvatar.startsWith('a_') ? 'gif' : 'png';
                avatarUrl = `https://cdn.discordapp.com/avatars/${discordId}/${userAvatar}.${ext}?size=256`;
              }
            }
          } catch {
            // ignore
          }
        }
      }

      if (!avatarUrl && /^\d{15,22}$/.test(discordId)) {
        try {
          const defaultIdx = Number((BigInt(discordId) >> 22n) % 6n);
          avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIdx}.png`;
        } catch {
          avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
        }
      }

      discordProfile = {
        discord_id: discordId,
        nickname: nickname || username || discordId,
        username: username || discordId,
        avatar_url: avatarUrl,
      };
    }

    // 4. Build clan tag -> name map for strikes
    const clanNameMap = new Map<string, string>();
    for (const c of familyClans ?? []) {
      const t = String(c.clan_tag ?? '').trim().toUpperCase();
      const name = String(c.clan_name ?? '').trim();
      if (t && name) {
        clanNameMap.set(t.startsWith('#') ? t : `#${t}`, name);
        clanNameMap.set(t.replace(/^#+/, ''), name);
      }
    }

    const resolveClanName = (cTag: unknown): string => {
      const s = String(cTag ?? '').trim();
      return clanNameMap.get(s.toUpperCase()) || s;
    };

    const currentSeasonStrikes = (confirmedStrikes ?? [])
      .filter((s) => s.is_active !== false)
      .map((s) => ({
        id: s.id,
        clan_tag: s.clan_tag,
        clan_name: resolveClanName(s.clan_tag),
        value: Number(s.value ?? 0),
        reason: s.reason ?? '',
        note: s.note ?? null,
        issued_date: s.issued_date ?? null,
        confirmed_by: s.confirmed_by ?? null,
        edited_by: s.edited_by ?? null,
      }));

    const currentSeasonTotal = currentSeasonStrikes.reduce((acc, s) => acc + s.value, 0);

    // Group past season strikes from strikes_archive + inactive strikes_confirmed (deduped by original_id)
    const archivedOriginalIds = new Set(
      (archivedStrikes ?? []).map((a) => String(a.original_id ?? '')).filter(Boolean)
    );
    const pastRaw = [
      ...(archivedStrikes ?? []).map((a) => ({
        id: a.id,
        clan_tag: a.clan_tag,
        clan_name: resolveClanName(a.clan_tag),
        value: Number(a.value ?? 0),
        reason: a.reason ?? '',
        note: a.note ?? null,
        issued_date: a.issued_date ?? null,
        confirmed_by: a.confirmed_by ?? null,
        season: String(a.season ?? 'Archived Season').trim() || 'Archived Season',
      })),
      ...(confirmedStrikes ?? [])
        .filter((s) => s.is_active === false && !archivedOriginalIds.has(String(s.id)))
        .map((s) => ({
          id: s.id,
          clan_tag: s.clan_tag,
          clan_name: resolveClanName(s.clan_tag),
          value: Number(s.value ?? 0),
          reason: s.reason ?? '',
          note: s.note ?? null,
          issued_date: s.issued_date ?? null,
          confirmed_by: s.confirmed_by ?? null,
          season: String(s.season ?? 'Past Season').trim() || 'Past Season',
        })),
    ];

    const pastSeasonsMap = new Map<
      string,
      {
        season: string;
        total: number;
        strikes: typeof currentSeasonStrikes;
      }
    >();

    for (const row of pastRaw) {
      const existing = pastSeasonsMap.get(row.season);
      const item = {
        id: row.id,
        clan_tag: row.clan_tag,
        clan_name: row.clan_name,
        value: row.value,
        reason: row.reason,
        note: row.note,
        issued_date: row.issued_date,
        confirmed_by: row.confirmed_by,
        edited_by: null,
      };
      if (existing) {
        existing.strikes.push(item);
        existing.total += row.value;
      } else {
        pastSeasonsMap.set(row.season, {
          season: row.season,
          total: row.value,
          strikes: [item],
        });
      }
    }

    // 5. Extract Friend in Need achievement
    const finAchievement = (profile.achievements ?? []).find(
      (a) => a.name.toLowerCase() === 'friend in need'
    );

    send(res, 200, {
      ok: true,
      player: {
        tag: profile.tag,
        name: profile.name,
        townHallLevel: profile.townHallLevel,
        townHallWeaponLevel: profile.townHallWeaponLevel ?? null,
        expLevel: profile.expLevel ?? null,
        trophies: profile.trophies ?? 0,
        bestTrophies: profile.bestTrophies ?? 0,
        warStars: profile.warStars ?? 0,
        role: profile.role ?? null,
        warPreference: profile.warPreference ?? null,
        donations: profile.donations ?? 0,
        donationsReceived: profile.donationsReceived ?? 0,
        clan: profile.clan ?? null,
        league: profile.league ?? null,
        leagueTier: profile.leagueTier ?? null,
        labels: profile.labels ?? [],
        heroes: (profile.heroes ?? []).filter((h) => h.village === 'home'),
        friendInNeed: finAchievement
          ? {
              value: finAchievement.value,
              target: finAchievement.target,
              stars: finAchievement.stars,
            }
          : null,
      },
      discord: discordProfile,
      strikes: {
        current_season: {
          total: currentSeasonTotal,
          strikes: currentSeasonStrikes,
        },
        past_seasons: Array.from(pastSeasonsMap.values()),
      },
    });
  } catch (error) {
    send(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to search player.',
    });
  }
}

/* ───────────────────── audit log endpoint ───────────────────── */

const REVERTABLE_TABLES = new Set([
  'allowed_user_ids',
  'page_permissions',
  'family_clans',
  'clan_players',
  'filler_accounts',
  'bot_settings',
  'family_wars',
  'cwl_seasons',
  'cwl_season_clans',
  'cwl_clans',
  'cwl_entries',
  'strike_reasons_global',
  'clan_strike_overrides',
  'clan_strike_custom',
  'strikes_pending',
  'strikes_confirmed',
  'strikes_archive',
]);

const CWL_REVERTABLE_UPDATE_TABLES = new Set([
  'cwl_seasons',
  'cwl_season_clans',
  'cwl_clans',
  'cwl_entries',
]);

let lastAuditPurgeAt = 0;

function deriveAuditAction(
  path: string,
  method: string | undefined,
  query: Record<string, string>,
  body: Record<string, unknown>,
  isCron?: boolean
): { action: string; skip: boolean } {
  const m = (method ?? 'GET').toUpperCase();
  const act = String(query.action || body.action || '').trim();
  const automatedPaths = new Set(['sync', 'sync-fillers', 'sync-wars', 'sync-clan-roster', 'sync-war-weights']);
  if (isCron || automatedPaths.has(path) || (path === 'cwl-roster' && act === 'sync_roles')) {
    return { action: `${path}${act ? `:${act}` : ''}`, skip: true };
  }
  const key = act ? `${path}:${act}` : `${m}:${path}`;
  const labels: Record<string, string> = {
    'POST:tracked-clans': 'tracked_clans.add',
    'DELETE:tracked-clans': 'tracked_clans.remove',
    'access-management:save_user': 'users.save_role',
    'access-management:delete_user': 'users.remove',
    'access-management:create_role': 'roles.create',
    'access-management:delete_role': 'roles.delete',
    'access-management:save_permission': 'permissions.save',
    'access-management:save_permissions': 'permissions.save_batch',
    'POST:add-clan-player': 'roster.add_player',
    'POST:edit-clan-player': 'roster.edit_player',
    'POST:edit-clan-players': 'roster.edit_batch',
    'POST:delete-clan-player': 'roster.remove_player',
    'POST:edit-war-weight': 'war_weights.edit',
    'POST:edit-war-weights': 'war_weights.edit_batch',
    'POST:sync-settings': 'wars.set_fwa_sync',
    'cwl-roster:create_season': 'cwl.create_season',
    'cwl-roster:close_season': 'cwl.close_season',
    'cwl-roster:rename_season': 'cwl.rename_season',
    'cwl-roster:update_clans': 'cwl.update_season_clans',
    'cwl-roster:add_clan': 'cwl.add_season_clan',
    'cwl-roster:remove_clan': 'cwl.remove_season_clan',
    'cwl-roster:set_size': 'cwl.set_roster_size',
    'cwl-roster:set_role': 'cwl.set_discord_role',
    'cwl-roster:assign': 'cwl.assign_player',
    'cwl-roster:assign_many': 'cwl.assign_batch',
    'cwl-roster:autofill': 'cwl.autofill',
    'cwl-roster:unassign': 'cwl.unassign',
    'POST:cwl-entries': 'cwl_entries.add',
    'PATCH:cwl-entries': 'cwl_entries.edit',
    'DELETE:cwl-entries': 'cwl_entries.delete',
    'POST:cwl-signup-settings': 'cwl.toggle_setting',
    'POST:cwl-clans': 'cwl_clans.add',
    'PATCH:cwl-clans': 'cwl_clans.edit',
    'DELETE:cwl-clans': 'cwl_clans.remove',
    'strike-config:save_reason': 'strike_config.save_global_reason',
    'strike-config:delete_reason': 'strike_config.delete_global_reason',
    'strike-config:save_override': 'strike_config.save_clan_override',
    'strike-config:delete_override': 'strike_config.delete_clan_override',
    'strike-config:save_custom': 'strike_config.save_clan_custom',
    'strike-config:delete_custom': 'strike_config.delete_clan_custom',
    'strikes:pending': 'strikes.stage_pending',
    'strikes:edit_pending': 'strikes.edit_pending',
    'strikes:delete_pending': 'strikes.delete_pending',
    'strikes:clear_pending': 'strikes.clear_pending',
    'strikes:confirm': 'strikes.confirm',
    'strikes:confirm_batch': 'strikes.confirm_batch',
    'strikes:edit_strike': 'strikes.edit_confirmed',
    'strikes:resolve': 'strikes.resolve',
    'strikes:reduce': 'strikes.reduce',
    'strikes:reset': 'strikes.season_reset',
    'audit-log:revert': 'audit_log.revert',
  };
  return { action: labels[key] || key, skip: false };
}

async function handleAuditLog(
  req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown; query?: Record<string, string | string[] | undefined> },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  auth: AuthResult
): Promise<void> {
  if (auth.ok === false) {
    send(res, 401, { ok: false, error: auth.message });
    return;
  }
  const canView = isManagement(auth) || (await canAccessClanPage(req, '*', 'audit_log'));
  if (!canView) {
    send(res, 403, { ok: false, error: 'You do not have permission to view the Audit Log.' });
    return;
  }

  const raw = rawAdminClient();

  // Opportunistic 90-day retention purge (at most once per hour per instance).
  if (Date.now() - lastAuditPurgeAt > 60 * 60 * 1000) {
    lastAuditPurgeAt = Date.now();
    void raw.rpc('audit_log_purge', { retention_days: 90 }).then(() => {}, () => {});
  }

  if (!req.method || req.method === 'GET') {
    const q = getQuery(req);
    if (q.action === 'request' && q.request_id) {
      const { data, error } = await raw
        .from('audit_log')
        .select('id,occurred_at,table_name,operation,row_pk,old_data,new_data,changed_fields,clan_tag,actor_discord_id,actor_name,actor_username,actor_role,actor_avatar_url,source,action,request_id,revert_of,reverted_at,reverted_by,reverted_by_log_id')
        .eq('request_id', q.request_id)
        .order('id', { ascending: true })
        .limit(500);
      if (error) {
        send(res, 500, { ok: false, error: error.message });
        return;
      }
      send(res, 200, { ok: true, logs: data ?? [] });
      return;
    }

    const limit = Math.min(Math.max(Number(q.limit) || 60, 1), 200);
    const beforeId = q.before_id ? Number(q.before_id) : null;
    const hasFilter = Boolean(
      q.table ||
        q.operation ||
        q.actor ||
        q.source ||
        q.clan_tag ||
        q.from ||
        q.to ||
        q.reverted ||
        (q.q && q.q.trim())
    );
    const needOverview = q.include_overview !== '0' && !beforeId;
    let query = raw
      .from('audit_log')
      .select(
        'id,occurred_at,table_name,operation,row_pk,old_data,new_data,changed_fields,clan_tag,actor_discord_id,actor_name,actor_username,actor_role,actor_avatar_url,source,action,request_id,revert_of,reverted_at,reverted_by,reverted_by_log_id',
        hasFilter && !beforeId ? { count: 'exact' } : undefined
      )
      .order('id', { ascending: false })
      .limit(limit);

    if (beforeId && Number.isFinite(beforeId)) query = query.lt('id', beforeId);
    if (q.table) query = query.eq('table_name', q.table);
    if (q.operation && ['INSERT', 'UPDATE', 'DELETE'].includes(q.operation.toUpperCase())) {
      query = query.eq('operation', q.operation.toUpperCase());
    }
    if (q.actor) {
      if (q.actor.startsWith('source:')) {
        query = query.eq('source', q.actor.slice(7));
      } else {
        query = query.eq('actor_discord_id', q.actor);
      }
    }
    if (q.source) query = query.eq('source', q.source);
    if (q.clan_tag) query = query.eq('clan_tag', q.clan_tag);
    if (q.from) query = query.gte('occurred_at', q.from);
    if (q.to) query = query.lte('occurred_at', q.to);
    if (q.reverted === 'only') query = query.not('reverted_at', 'is', null);
    if (q.reverted === 'active') query = query.is('reverted_at', null);
    if (q.q && q.q.trim()) {
      const term = q.q.trim().toLowerCase().replace(/[%_]/g, '\\$&');
      query = query.ilike('search_text', `%${term}%`);
    }

    const [listRes, overviewRes, clansRes] = await Promise.all([
      query,
      needOverview ? raw.rpc('audit_log_overview') : Promise.resolve({ data: null, error: null }),
      needOverview ? raw.from('family_clans').select('clan_tag, clan_name').order('clan_name') : Promise.resolve({ data: null, error: null }),
    ]);

    if (listRes.error) {
      const msg = listRes.error.message || 'Failed to query audit log.';
      const missing = msg.toLowerCase().includes('audit_log') && (msg.toLowerCase().includes('does not exist') || msg.toLowerCase().includes('schema cache'));
      send(res, missing ? 200 : 500, {
        ok: !missing,
        not_installed: missing,
        logs: [],
        total: 0,
        error: missing ? 'Run supabase/audit-log.sql in the Supabase SQL Editor to enable database auditing.' : msg,
      });
      return;
    }

    const rows = listRes.data ?? [];
    const overviewObj = (overviewRes.data ?? null) as { total?: number } | null;
    send(res, 200, {
      ok: true,
      logs: rows,
      total: listRes.count ?? (!hasFilter && typeof overviewObj?.total === 'number' ? overviewObj.total : rows.length),
      next_cursor: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null,
      overview: overviewRes.data ?? undefined,
      clans: clansRes.data ?? undefined,
    });
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use GET or POST.' });
    return;
  }

  const body = readJsonBody(req);
  const action = String(body.action ?? '');

  if (action === 'revert') {
    if (!isDeveloper(auth)) {
      send(res, 403, { ok: false, error: 'Only Developers can revert database changes.' });
      return;
    }
    const logId = Number(body.id);
    if (!Number.isFinite(logId) || logId <= 0) {
      send(res, 400, { ok: false, error: 'Valid log entry ID is required.' });
      return;
    }
    const { data: entry, error: fetchErr } = await raw
      .from('audit_log')
      .select('*')
      .eq('id', logId)
      .maybeSingle();
    if (fetchErr || !entry) {
      send(res, 404, { ok: false, error: fetchErr?.message || 'Audit entry not found.' });
      return;
    }
    if (entry.reverted_at) {
      send(res, 400, { ok: false, error: 'This change has already been reverted.' });
      return;
    }
    const table = String(entry.table_name ?? '');
    if (!REVERTABLE_TABLES.has(table)) {
      send(res, 400, { ok: false, error: `Reverting table "${table}" is not allowed.` });
      return;
    }
    const pk = (entry.row_pk ?? null) as Record<string, unknown> | null;
    const pkEntries = pk ? Object.entries(pk).filter(([, v]) => v !== null && v !== undefined) : [];
    const op = String(entry.operation ?? '');
    if (op === 'UPDATE' && !CWL_REVERTABLE_UPDATE_TABLES.has(table)) {
      send(res, 400, {
        ok: false,
        error: 'Reverting edits is only enabled for CWL changes (or new entry additions and deletions).',
      });
      return;
    }

    // Execute the inverse write with audit headers pointing back to `logId`.
    const audited = adminClient({ revertOf: logId, action: `audit_log.revert:${table}` });

    if (op === 'INSERT') {
      if (pkEntries.length === 0) {
        send(res, 400, { ok: false, error: 'Cannot revert INSERT: row primary key was not recorded.' });
        return;
      }
      let del = audited.from(table).delete();
      for (const [k, v] of pkEntries) del = del.eq(k, v as string);
      const { error: delErr } = await del;
      if (delErr) {
        send(res, 500, { ok: false, error: `Revert DELETE failed: ${delErr.message}` });
        return;
      }
    } else if (op === 'DELETE') {
      const oldRow = entry.old_data as Record<string, unknown> | null;
      if (!oldRow || typeof oldRow !== 'object') {
        send(res, 400, { ok: false, error: 'Cannot revert DELETE: previous row data is missing.' });
        return;
      }
      const { error: insErr } = await audited.from(table).insert(oldRow);
      if (insErr) {
        send(res, 500, { ok: false, error: `Revert INSERT failed: ${insErr.message}` });
        return;
      }
    } else if (op === 'UPDATE') {
      const oldRow = entry.old_data as Record<string, unknown> | null;
      if (!oldRow || pkEntries.length === 0) {
        send(res, 400, { ok: false, error: 'Cannot revert UPDATE: primary key or previous values missing.' });
        return;
      }
      const changed: string[] = Array.isArray(entry.changed_fields) && entry.changed_fields.length > 0
        ? entry.changed_fields
        : Object.keys(oldRow);
      const patch: Record<string, unknown> = {};
      for (const col of changed) {
        if (col in oldRow) patch[col] = oldRow[col];
      }
      let upd = audited.from(table).update(patch);
      for (const [k, v] of pkEntries) upd = upd.eq(k, v as string);
      const { error: updErr } = await upd;
      if (updErr) {
        send(res, 500, { ok: false, error: `Revert UPDATE failed: ${updErr.message}` });
        return;
      }
    } else {
      send(res, 400, { ok: false, error: `Unsupported operation "${op}".` });
      return;
    }

    const { data: revertRow } = await raw
      .from('audit_log')
      .select('id')
      .eq('revert_of', logId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    const actorLabel = auth.user?.name || auth.user?.username || auth.user?.discordId || 'Developer';
    await raw
      .from('audit_log')
      .update({
        reverted_at: new Date().toISOString(),
        reverted_by: actorLabel,
        reverted_by_log_id: revertRow?.id ?? null,
      })
      .eq('id', logId);

    send(res, 200, { ok: true, reverted_id: logId, new_log_id: revertRow?.id ?? null });
    return;
  }

  send(res, 400, { ok: false, error: `Unknown audit-log action: ${action}` });
}

/* ───────────────────── route dispatch ───────────────────── */

export default async function handler(req: unknown, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): Promise<void> {
  try {
    const r = req as {
      method?: string;
      url: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
      query?: Record<string, string | string[] | undefined>;
    };

    // env-check is public (diagnostic tool, no auth needed)
    const pathCheck = r.url?.split('?')[0] ?? '';
    if (pathCheck.endsWith('/env-check')) {
      send(res, 200, {
        ok: true,
        env: {
          SUPABASE_URL: !!URL,
          SUPABASE_SERVICE_ROLE_KEY: !!SERVICE_KEY,
          SUPABASE_ANON_KEY: !!ANON_KEY,
          CRON_SECRET: !!CRON_SECRET,
        },
      });
      return;
    }

    const auth = await authorize(r);
    if (auth.ok === false) {
      send(res, 401, { ok: false, error: auth.message });
      return;
    }

    // Normalize path: strip leading /api/ and trailing slash
    let path = r.url?.split('?')[0] ?? '';
    if (path.startsWith('/api/')) path = path.slice(5);
    if (path.endsWith('/')) path = path.slice(0, -1);

    // Also check query slug (Vercel dynamic route fallback)
    if (!path || path === '[...slug]') {
      path = String(r.query?.slug ?? '');
    }

    const globalPageByPath: Record<string, 'cwl' | 'fillers' | 'wars'> = {
      'cwl-clans': 'cwl',
      'cwl-signup-settings': 'cwl',
      'cwl-entries': 'cwl',
      'cwl-roster': 'cwl',
      'sync-fillers': 'fillers',
      'sync-wars': 'wars',
      sync: 'wars',
    };
    const globalPage = globalPageByPath[path];
    if (globalPage && !(auth.ok && auth.role === 'Developer' && !getHeader(r, 'authorization'))) {
      const accessLevel = await getClanPageAccessLevel(r, '*', globalPage);
      const isReadMethod = !r.method || r.method === 'GET' || r.method === 'HEAD';
      if (accessLevel === 'none') {
        send(res, 403, { ok: false, error: 'You do not have access to this page.' });
        return;
      }
      if (!isReadMethod && accessLevel !== 'edit') {
        send(res, 403, { ok: false, error: 'You only have view access to this page.' });
        return;
      }
    }

    // Route dispatch (wrapped in audit context so every adminClient() write
    // carries the authenticated user's Discord identity and action label)
    const dispatchQuery = getQuery(r);
    const dispatchBody = r.method && r.method !== 'GET' && r.method !== 'HEAD' ? readJsonBody(r) : {};
    const { action: auditAction, skip: auditSkip } = deriveAuditAction(path, r.method, dispatchQuery, dispatchBody, auth.isCron);
    const auditCtx: AuditContext = {
      requestId: randomUUID(),
      action: auditAction,
      skip: auditSkip,
      discordId: auth.user?.discordId,
      name: auth.user?.name,
      username: auth.user?.username,
      role: auth.role,
      avatarUrl: auth.user?.avatarUrl,
    };

    await auditStorage.run(auditCtx, async () => {
      switch (path) {
        case 'audit-log':
          await handleAuditLog(r, res, auth);
          break;
        case 'player-search':
        await handlePlayerSearch(r, res);
        break;
      case 'discord-profile':
        await handleDiscordProfile(r, res, auth);
        break;
      case 'tracked-clans':
        await handleTrackedClans(r, res, auth);
        break;
      case 'access-management':
        await handleAccessManagement(r, res, auth);
        break;
      case 'clan-roster':
        await handleClanRoster(r, res);
        break;
      case 'sync-clan-roster':
        await handleSyncClanRoster(r, res);
        break;
      case 'edit-clan-player':
        await handleEditClanPlayer(r, res);
        break;
      case 'edit-clan-players':
        await handleEditClanPlayers(r, res);
        break;
      case 'add-clan-player':
        await handleAddClanPlayer(r, res);
        break;
      case 'delete-clan-player':
        await handleDeleteClanPlayer(r, res);
        break;
      case 'war-weights':
        await handleWarWeights(r, res);
        break;
      case 'sync-war-weights':
        await handleSyncWarWeights(r, res);
        break;
      case 'edit-war-weight':
        await handleEditWarWeight(r, res);
        break;
      case 'edit-war-weights':
        await handleEditWarWeights(r, res);
        break;
      case 'sync':
        await handleSync(r, res);
        break;
      case 'sync-settings':
        await handleSyncSettings(r, res, auth);
        break;
      case 'sync-fillers':
        await handleSync(r, res);
        break;
      case 'sync-wars':
        await handleSync(r, res);
        break;
      case 'cwl-clans':
        await handleCwlClans(r, res, auth);
        break;
      case 'cwl-roster':
        await handleCwlRoster(r, res, auth);
        break;
      case 'cwl-entries':
        await handleCwlEntries(r, res, auth);
        break;
      case 'cwl-signup-settings':
        await handleCwlSignupSettings(r, res, auth);
        break;
      case 'strike-config':
        if (getQuery(r).type === 'global') {
          await handleStrikeConfigGlobal(r, res, auth);
        } else {
          await handleStrikeConfigClan(r, res, auth);
        }
        break;
      case 'strikes': {
        const q = getQuery(r);
        const body = r.method === 'POST' ? readJsonBody(r) : {};
        const strikeClanTag = String(q.clan_tag ?? body.clan_tag ?? '*').trim() || '*';
        const isRead = !r.method || r.method === 'GET';
        const strikePageKey: PageKey =
          q.action === 'confirmed' || q.action === 'resolve' || q.action === 'reduce' || q.action === 'edit_strike'
            ? 'strike_board'
            : 'strike_manager';
        if (!isManagement(auth)) {
          const allowed = isRead
            ? await canAccessClanPage(r, strikeClanTag, strikePageKey)
            : await canEditClanPage(r, strikeClanTag, strikePageKey);
          if (!allowed) {
            send(res, 403, {
              ok: false,
              error: isRead
                ? 'You do not have access to clan strikes.'
                : 'You only have view access to clan strikes.',
            });
            break;
          }
        }
        switch (q.action) {
          case 'pending':
            await handleStrikesPending(r, res, auth);
            break;
          case 'confirm':
            await handleStrikesConfirm(r, res, auth);
            break;
          case 'confirmed':
            await handleStrikesConfirmed(r, res);
            break;
          case 'resolve':
            await handleStrikesResolve(r, res, auth);
            break;
          case 'reduce':
            await handleStrikesReduce(r, res, auth);
            break;
          case 'reset':
            await handleStrikesReset(r, res, auth);
            break;
          case 'confirm_batch':
            await handleStrikesConfirmBatch(r, res, auth);
            break;
          case 'clear_pending':
            await handleStrikesClearPending(r, res, auth);
            break;
          case 'delete_pending':
            await handleStrikesDeletePending(r, res, auth);
            break;
          case 'edit_pending':
            await handleStrikesEditPending(r, res, auth);
            break;
          case 'edit_strike':
            await handleStrikesEdit(r, res, auth);
            break;
          default:
            send(res, 404, { ok: false, error: `Unknown strikes action: ${getQuery(r).action}` });
        }
        break;
      }
      default:
        send(res, 404, { ok: false, error: `Not found. Path: ${path || '(empty)'}` });
    }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, 500, { ok: false, error: message });
  }
}