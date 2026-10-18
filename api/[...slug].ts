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
  if (r === 'co-leader' || r === 'coleader' || r === 'rep') return 'coleader';
  if (r === 'elder' || r === 'staff' || r === 'admin') return 'elder';
  if (r === 'member') return 'member';
  if (r === 'filler') return 'filler';
  return r;
}

/* ───────────────────── handlers ───────────────────── */

// GET /api/tracked-clans — list tracked clans (family_clans)
// POST /api/tracked-clans — add clan (Developer)
// DELETE /api/tracked-clans?clan_tag=#TAG — remove clan (Developer)
async function handleTrackedClans(req: { method?: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, auth: AuthResult): Promise<void> {
  const method = req.method ?? 'GET';
  const isDev = isDeveloper(auth);

  if (method === 'GET') {
    try {
      const supabase = adminClient();
      const { data, error } = await supabase
        .from('family_clans')
        .select('clan_tag, clan_name, added_date')
        .order('added_date', { ascending: true });
      if (error) throw new Error(error.message);
      send(res, 200, { ok: true, clans: data ?? [] });
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Failed to load clans.' });
    }
    return;
  }

  if (!isDev) {
    send(res, 403, { ok: false, error: 'Developer role required.' });
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
    const { data, error } = await supabase
      .from('clan_players')
      .select('id, player_name, player_tag, discord_id, town_hall, role, status, join_date, days_in_clan, war_weight, updated_date')
      .eq('clan_tag', clanTag)
      .order('war_weight', { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);
    send(res, 200, { ok: true, clan_tag: clanTag, players: data ?? [] });
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
    const clanTag = await resolveClanTag(supabase, clanTagRaw);

    // Ensure the clan exists in family_clans (foreign key parent)
    const { data: existingClan, error: clanSelectError } = await supabase
      .from('family_clans')
      .select('clan_tag')
      .eq('clan_tag', clanTag)
      .maybeSingle();
    if (clanSelectError) throw new Error(clanSelectError.message);
    if (!existingClan) {
      const { error: clanInsertError } = await supabase
        .from('family_clans')
        .insert({ clan_tag: clanTag, clan_name: clanTag });
      if (clanInsertError) throw new Error(clanInsertError.message);
    }

    let clan;
    try {
      clan = await getClan(clanTag);
    } catch {
      send(res, 404, { ok: false, error: `Clan ${clanTag} not found in CoC API.` });
      return;
    }

    const members = clan.memberList ?? [];
    if (members.length === 0) {
      send(res, 200, { ok: true, updated: 0, message: 'No members found.' });
      return;
    }

    const tags = members.map((m) => m.tag);
    const discordIdMap: Record<string, string> = {};
    try {
      const { data: linked, error: linkedError } = await supabase
        .from('playerbase')
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

    const { data: existing } = await supabase
      .from('clan_players')
      .select('player_tag, role, join_date')
      .eq('clan_tag', clanTag);
    const existingByTag = new Map<string, { role: string; join_date: string | null }>();
    if (existing) {
      for (const row of existing) {
        existingByTag.set(row.player_tag, { role: row.role, join_date: row.join_date });
      }
    }

    const now = new Date();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const upserts = members.map((member) => {
      const existingRow = existingByTag.get(member.tag);
      const igRole = cocRoleToWebsiteRole(member.role);
      const previousRole = existingRow?.role ?? '';
      const previousJoinDate = existingRow?.join_date ?? null;
      const joinDate = previousJoinDate ?? now.toISOString();
      const joinTime = new Date(joinDate).getTime();
      const daysInClan = previousJoinDate
        ? Math.floor((now.getTime() - joinTime) / oneDayMs)
        : 0;

      let status: string;
      const normalizedPrevious = normalizeRoleForComparison(previousRole);
      const normalizedIg = normalizeRoleForComparison(member.role);

      if (normalizedIg === 'filler') {
        status = 'All good';
      } else if (previousRole && normalizedPrevious !== '' && normalizedPrevious !== normalizedIg) {
        status = 'Role Mismatch';
      } else {
        status = 'All good';
      }

      return {
        clan_tag: clanTag,
        player_name: member.name,
        player_tag: member.tag,
        discord_id: discordIdMap[member.tag] ?? null,
        town_hall: member.town_hall ?? null,
        role: igRole,
        status,
        join_date: joinDate,
        days_in_clan: daysInClan,
        war_weight: null,
        updated_date: now.toISOString(),
      };
    });

    const CHUNK = 50;
    let updated = 0;
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const chunk = upserts.slice(i, i + CHUNK);
      const { error } = await supabase.from('clan_players').upsert(chunk, { onConflict: 'clan_tag, player_tag' });
      if (error) throw new Error(error.message);
      updated += chunk.length;
    }

    send(res, 200, { ok: true, updated, clan_tag: clanTag, clan_name: clan.name });
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
    const clanTag = await resolveClanTag(supabase, clanTagRaw);
    const playerTag = `#${cleanPlayer}`;

    // Ensure the clan exists in family_clans (foreign key parent)
    const { data: existingClan, error: clanSelectError } = await supabase
      .from('family_clans')
      .select('clan_tag')
      .eq('clan_tag', clanTag)
      .maybeSingle();
    if (clanSelectError) throw new Error(clanSelectError.message);
    if (!existingClan) {
      const { error: clanInsertError } = await supabase
        .from('family_clans')
        .insert({ clan_tag: clanTag, clan_name: clanTag });
      if (clanInsertError) throw new Error(clanInsertError.message);
    }

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
      const { data: linked, error: linkedError } = await supabase
        .from('playerbase')
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

    const roster = [...(war.clan as { name: string; tag: string; map_position?: number; town_hall?: number }[])]
      .sort((a, b) => (a.map_position ?? 999) - (b.map_position ?? 999));
    if (roster.length === 0) {
      send(res, 200, { ok: true, updated: 0, message: 'No roster members in war.' });
      return;
    }

    const now = new Date().toISOString();
    const upserts = roster.map((member, index) => {
      const th = member.town_hall ?? 0;
      const value = th;
      return {
        clan_tag: clanTag,
        player_name: member.name,
        player_tag: member.tag,
        town_hall: th,
        value,
        war_weight: value * 5,
        map_position: index + 1,
        updated_date: now,
      };
    });

    const CHUNK = 50;
    let updated = 0;
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const chunk = upserts.slice(i, i + CHUNK);
      const { error } = await supabase.from('war_weights').upsert(chunk, { onConflict: 'clan_tag, player_tag' });
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
      send(res, 200, { ok: true, updated: data[0] });
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Update failed.' });
    }
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Update failed.' });
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
    let syncState = settingRows?.[0]?.setting_value === 'Low' ? 'Low' : 'High';
    const TOGGLE_CLAN = '#2C8PR82G';

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

        let effectiveSync = syncState;
        let flippedThisWar = false;
        if (tag.toUpperCase() === TOGGLE_CLAN && war.state === 'warEnded') {
          const alreadyFinal = !!existing?.[0] && ['win', 'won', 'victory', 'loss', 'lost', 'lose', 'defeat', 'tie'].some((w) =>
            String(existing[0].war_result ?? '').trim().toLowerCase().includes(w)
          );
          if (!alreadyFinal) {
            effectiveSync = syncState === 'High' ? 'Low' : 'High';
            flippedThisWar = true;
          }
        }

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
        if (flippedThisWar) {
          syncState = effectiveSync;
          const { error: syncError } = await supabase
            .from('bot_settings')
            .update({ setting_value: syncState })
            .eq('setting_key', 'fwa_sync_state');
          if (syncError) throw new Error(syncError.message);
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
  if (!isDeveloper(auth)) {
    send(res, 403, { ok: false, error: 'Developer role required.' });
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

  // Route dispatch
  switch (path) {
    case 'tracked-clans':
      await handleTrackedClans(r, res, auth);
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
    case 'add-clan-player':
      await handleAddClanPlayer(r, res);
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
