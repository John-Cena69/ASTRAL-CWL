// api/[...slug].ts — Single catch-all serverless function
// Replaces 13 individual API files to stay under Vercel Hobby's 12-function limit.
// All frontend fetch URLs stay exactly the same.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  CocMaintenance,
  CocNotFound,
  PrivateWarLog,
  getClan,
  getCurrentWar,
  getPlayer,
  toUnixSeconds,
} from './_lib/coc.js';
import { calculateFwaResult, getFwaPoints, lookupPoints } from './_lib/fwa.js';
import { playerbaseAdminClient } from './_lib/backend.js';

/* ───────────────────── config ───────────────────── */

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

function adminClient(): SupabaseClient {
  const missing: string[] = [];
  if (!URL) missing.push('SUPABASE_URL');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    throw new Error(`Missing server env vars: ${missing.join(', ')}. Set them in Vercel Project Settings → Environment Variables.`);
  }
  return createClient(URL, SERVICE_KEY);
}

/* ───────────────────── auth ───────────────────── */

type AuthResult = { ok: true; role?: string } | { ok: false; message: string };

function getHeader(req: { url: string; headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

async function authorize(req: { url: string; headers: Record<string, string | string[] | undefined> }): Promise<AuthResult> {
  const supplied = getHeader(req, 'x-cron-secret');
  if (CRON_SECRET && supplied && supplied === CRON_SECRET) return { ok: true, role: 'Developer' };

  const authHeader = getHeader(req, 'authorization');
  const token =
    authHeader.startsWith('Bearer ') && authHeader.slice(7) !== CRON_SECRET
      ? authHeader.slice(7)
      : '';
  if (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) return { ok: true, role: 'Developer' };
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

function isDeveloper(auth: AuthResult): boolean {
  return auth.ok === true && auth.role === 'Developer';
}

function isManagement(auth: AuthResult): boolean {
  return auth.ok === true && ['Developer', 'Admin'].includes(auth.role ?? '');
}

async function canAccessClanPage(
  req: { url: string; headers: Record<string, string | string[] | undefined> },
  clanTag: string,
  pageKey: 'cwl' | 'fillers' | 'wars' | 'clan_management' | 'clan_access' | 'roster' | 'clans' | 'accounts' | 'clan_home' | 'war_weights' | 'user_management'
): Promise<boolean> {
  const authHeader = getHeader(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !URL || !ANON_KEY) return false;
  const client = createClient(URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.rpc('can_access_clan_page', {
    requested_clan_tag: clanTag,
    requested_page_key: pageKey,
  });
  return !error && data === true;
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
    const url = new URL(req.url, 'http://localhost');
    url.searchParams.forEach((v, k) => {
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
    const [{ data: users, error: usersError }, { data: clans, error: clansError }, { data: permissions, error: permissionsError }] = await Promise.all([
      supabase.from('allowed_user_ids').select('discord_user_id, role, created_at').order('created_at'),
      supabase.from('family_clans').select('clan_tag, clan_name').order('clan_name'),
      supabase.from('page_permissions').select('clan_tag, role, page_key, allowed').order('clan_tag'),
    ]);
    const error = usersError || clansError || permissionsError;
    if (error) {
      send(res, 500, { ok: false, error: error.message });
      return;
    }
    const roles = [...new Set((users ?? []).map((user) => user.role).filter(Boolean))];
    send(res, 200, { ok: true, users: users ?? [], clans: clans ?? [], permissions: permissions ?? [], roles });
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
  if (action === 'save_permission') {
    const clanTag = String(body.clan_tag ?? '').trim();
    const role = String(body.role ?? '').trim();
    const pageKey = String(body.page_key ?? '').trim();
    if (!clanTag || !role || !['cwl', 'fillers', 'wars', 'clan_management', 'clan_access', 'roster', 'clans', 'accounts', 'clan_home', 'war_weights', 'user_management'].includes(pageKey)) {
      send(res, 400, { ok: false, error: 'Clan, role, and a valid page are required.' });
      return;
    }
    const { error } = await supabase.from('page_permissions').upsert({
      clan_tag: clanTag,
      role,
      page_key: pageKey,
      allowed: body.allowed === true,
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
    const pageKeys = ['cwl', 'fillers', 'wars', 'clan_management', 'clan_access'];
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
        rows.push({
          clan_tag: clanTag,
          role,
          page_key: pageKey,
          allowed: row.allowed === true,
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

  try {
    const supabase = adminClient();
    const resolvedClanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canAccessClanPage(req, resolvedClanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You do not have access to this clan page.' });
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
    const tags = members.map((m) => m.tag);
    const membersByTag = new Map(members.map((member) => [member.tag, member]));
    const discordIdMap: Record<string, string> = {};
    if (tags.length > 0) {
      try {
        const playerbase = playerbaseAdminClient();
        const { data: linked, error: linkedError } = await playerbase
          .from('linked_players')
          .select('player_tag, discord_id')
          .in('player_tag', tags);
        if (!linkedError && linked) {
          for (const item of linked) {
            discordIdMap[item.player_tag] = item.discord_id ?? '';
          }
        }
      } catch {
        // ignore
      }
    }

    const { data: existing } = await supabase
      .from('clan_players')
      .select('player_tag, role, join_date')
      .eq('clan_tag', clanTag);

    const now = new Date();

    let updated = 0;
    let missing = 0;
    let roleMismatches = 0;
    for (const player of existing ?? []) {
      const member = membersByTag.get(player.player_tag);
      const status = !member
        ? 'Missing from Clan'
        : normalizeRoleForComparison(player.role ?? '') === normalizeRoleForComparison(member.role)
          ? 'All good'
          : 'Role Mismatch';
      if (status === 'Missing from Clan') missing += 1;
      if (status === 'Role Mismatch') roleMismatches += 1;

      const updates = {
        status,
        updated_date: now.toISOString(),
        ...(member
          ? {
              player_name: member.name,
              discord_id: discordIdMap[member.tag] ?? null,
              town_hall: member.townHallLevel ?? null,
            }
          : {}),
      };
      const { error } = await supabase
        .from('clan_players')
        .update(updates)
        .eq('clan_tag', clanTag)
        .eq('player_tag', player.player_tag);
      if (error) throw new Error(error.message);
      updated += 1;
    }
    send(res, 200, { ok: true, updated, missing, role_mismatches: roleMismatches, clan_tag: clanTag, clan_name: clan.name });
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
    if (!await canAccessClanPage(req, clanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You do not have access to this clan page.' });
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
    if (!await canAccessClanPage(req, clanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You do not have access to this clan page.' });
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
        discordId = linked.discord_id ?? null;
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
    if (!await canAccessClanPage(req, clanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You do not have access to this clan page.' });
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
      send(res, 403, { ok: false, error: 'You do not have access to this clan page.' });
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
    if (!await canAccessClanPage(req, clanTag, 'war_weights')) {
      send(res, 403, { ok: false, error: 'You do not have access to this clan page.' });
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

    const previousValues = new Map(
      (existingWeights ?? []).map((weight) => [weight.player_tag, weight.value ?? 0])
    );
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
  const value = body.value ?? null;

  if (!clanTagRaw || !playerTagRaw) {
    send(res, 400, { ok: false, error: 'Clan tag and player tag are required.' });
    return;
  }
  if (value === null || value === undefined || !Number.isInteger(value) || value < 0) {
    send(res, 400, { ok: false, error: 'Value must be a whole number of 0 or greater.' });
    return;
  }

  try {
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canAccessClanPage(req, clanTag, 'clan_home')) {
      send(res, 403, { ok: false, error: 'You do not have access to this clan page.' });
      return;
    }
    const playerTag = `#${playerTagRaw.toUpperCase().replace(/^#+/, '')}`;

    try {
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
        send(res, 404, { ok: false, error: 'Player not found in war weights.' });
        return;
      }

      // Also sync to clan_players so the home page roster reflects the change
      await supabase
        .from('clan_players')
        .update({ war_weight: value * 5, updated_date: new Date().toISOString() })
        .eq('clan_tag', clanTag)
        .eq('player_tag', playerTag);

      send(res, 200, { ok: true, updated: data[0] });
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
    const supabase = adminClient();
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    if (!await canAccessClanPage(req, clanTag, 'war_weights')) {
      send(res, 403, { ok: false, error: 'You do not have access to this clan page.' });
      return;
    }
    const now = new Date().toISOString();
    let updated = 0;
    const failed: string[] = [];

    for (const update of parsedUpdates) {
      const { data, error } = await supabase
        .from('war_weights')
        .update({
          value: update.value,
          war_weight: update.value * 5,
          updated_date: now,
        })
        .eq('clan_tag', clanTag)
        .eq('player_tag', update.playerTag)
        .select('player_tag');
      if (error) throw new Error(error.message);
      if (data?.length) updated += 1;
      else failed.push(update.playerTag);

      // Also sync to clan_players so the home page roster reflects the change
      await supabase
        .from('clan_players')
        .update({ war_weight: update.value * 5, updated_date: now })
        .eq('clan_tag', clanTag)
        .eq('player_tag', update.playerTag);
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
  if (!auth.ok || !await canAccessClanPage(req, '*', 'wars')) {
    send(res, 403, { ok: false, error: 'Wars access is required to change the FWA sync state.' });
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
    const tag = await resolveClanTag(supabase, rawTag);
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
    'sync-fillers': 'fillers',
    'sync-wars': 'wars',
  };
  const globalPage = globalPageByPath[path];
  if (globalPage && !(auth.ok && auth.role === 'Developer' && !getHeader(r, 'authorization'))) {
    if (!await canAccessClanPage(r, '*', globalPage)) {
      send(res, 403, { ok: false, error: 'You do not have access to this page.' });
      return;
    }
  }

  // Route dispatch
  switch (path) {
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
      // falls into /api/sync logic handled inline in handleSync; keep a lightweight redirect
      await handleSync(r, res);
      break;
    case 'sync-wars':
      await handleSync(r, res);
      break;
    case 'cwl-clans':
      await handleCwlClans(r, res, auth);
      break;
    default:
      send(res, 404, { ok: false, error: `Not found. Path: ${path || '(empty)'}` });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, 500, { ok: false, error: message, stack: error instanceof Error ? error.stack : undefined });
  }
}
