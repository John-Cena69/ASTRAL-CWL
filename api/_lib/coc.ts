// CoC API client. Works against the official API or the RoyaleAPI proxy
// (same paths). The proxy lets Vercel call the API with no static IP:
// create the key at developer.clashofclans.com whitelisted to the proxy IP
// and point COC_API_BASE_URL at the proxy.
const BASE_URL =
  process.env.COC_API_BASE_URL || 'https://cocproxy.royaleapi.dev/v1';
const API_KEY = process.env.COC_API_KEY || '';

export class PrivateWarLog extends Error {}
export class CocMaintenance extends Error {}
export class CocNotFound extends Error {}

function tagParam(tag: string): string {
  const clean = tag.trim().toUpperCase().replace(/^#+/, '');
  return encodeURIComponent(`#${clean}`);
}

async function request(path: string, retries = 1): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 429 && retries > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return request(path, retries - 1);
  }

  if (response.status === 503 || response.status === 504) {
    throw new CocMaintenance(`CoC API unavailable (status ${response.status})`);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // non-JSON body
  }

  if (response.status === 403 && body.reason === 'accessDenied.invalidIp') {
    throw new Error(
      'CoC API key rejected this server IP. If COC_API_BASE_URL is the official API, switch it to the proxy URL (see api/_lib/coc.ts header).'
    );
  }
  if (response.status === 403) {
    const reason = [body.reason, body.message].filter(Boolean).join(' ').slice(0, 160);
    throw new PrivateWarLog(`${path}: ${reason || 'forbidden'}`);
  }
  if (response.status === 404) throw new CocNotFound(`Not found: ${path}`);
  if (!response.ok) {
    throw new Error(`CoC API error ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

export interface CocPlayer {
  tag: string;
  name: string;
  townHallLevel: number | null;
  clan?: { tag: string; name: string };
}

export async function getPlayer(tag: string): Promise<CocPlayer> {
  const body = (await request(`/players/${tagParam(tag)}`)) as {
    tag: string;
    name: string;
    townHallLevel?: number;
    clan?: { tag: string; name: string };
  };
  return {
    tag: body.tag,
    name: body.name,
    townHallLevel: body.townHallLevel ?? null,
    clan: body.clan ? { tag: body.clan.tag, name: body.clan.name } : undefined,
  };
}

export interface CocWar {
  state: string;
  clan: {
    tag: string;
    name: string;
    badgeUrls?: { medium?: string; large?: string; small?: string };
    stars: number;
    attacks: number;
    members?: {
      tag: string;
      name: string;
      mapPosition?: number;
      townHallLevel?: number;
    }[];
  };
  opponent: { tag: string; name: string; stars: number; attacks: number };
  preparationStartTime?: string;
  endTime?: string;
}

/** Returns null when the clan is not in war (mirrors coc.py behaviour). */
export async function getCurrentWar(clanTag: string): Promise<CocWar | null> {
  let body: CocWar;
  try {
    body = (await request(`/clans/${tagParam(clanTag)}/currentwar`)) as CocWar;
  } catch (error) {
    if (error instanceof CocNotFound) return null;
    throw error;
  }
  if (!body || body.state === 'notInWar') return null;
  return body;
}

export interface CocClan {
  tag: string;
  name: string;
  badgeUrls?: { small?: string; medium?: string; large?: string };
  warLeague?: { name: string };
  memberList?: {
    tag: string;
    name: string;
    role: string;
    townHallLevel?: number;
  }[];
}

/** Full clan profile (used by the Clans directory to auto-fill on add). */
export async function getClan(tag: string): Promise<CocClan> {
  return (await request(`/clans/${tagParam(tag)}`)) as CocClan;
}

/** "20250101T120000.000Z" -> unix seconds (0 when missing/unparseable). */
export function toUnixSeconds(value?: string): number {
  if (!value) return 0;
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/
  );
  if (!match) return 0;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi, s) / 1000);
}
