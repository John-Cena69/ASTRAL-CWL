// FWA points + war-result logic ported 1:1 from the coc.py FWATracker cog.
export type FwaSyncState = 'Low' | 'High';

export function calculateFwaResult(
  ourPoints: number,
  opponentPoints: number,
  ourTag: string,
  opponentTag: string,
  syncState: string
): string {
  if (ourPoints > opponentPoints) return 'Win';
  if (ourPoints < opponentPoints) return 'Loss';
  const t1 = ourTag.replace(/#/g, '');
  const t2 = opponentTag.replace(/#/g, '');
  if (syncState === 'Low') return t1 < t2 ? 'Win' : 'Loss';
  return t1 > t2 ? 'Win' : 'Loss';
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      current.push(field);
      field = '';
    } else if (char === '\n') {
      current.push(field);
      rows.push(current);
      current = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

let pointsCache = new Map<string, number>();
let pointsCacheAt = 0;

function pointsCsvUrl(): string {
  const override = process.env.FWA_POINTS_CSV_URL;
  if (override) return override;
  const sheetId = process.env.FWA_SPREADSHEET_ID || '';
  const gid = process.env.FWA_POINTS_GID || '0';
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

/**
 * Clan Tag -> Clan Points from the "FWA Points" sheet tab.
 * Refreshes at most every 30 min (60s minimum for a new war),
 * matching the original bot's caching behaviour.
 */
export async function getFwaPoints(force = false): Promise<Map<string, number>> {
  const ageMs = Date.now() - pointsCacheAt;
  const stale = pointsCache.size === 0 || ageMs >= 30 * 60 * 1000;
  if (!force && !stale) return pointsCache;

  const response = await fetch(pointsCsvUrl(), { cache: 'no-store' });
  if (!response.ok) {
    if (pointsCache.size > 0) return pointsCache;
    throw new Error(
      `Could not fetch FWA Points sheet (status ${response.status}). Share the sheet as "Anyone with link can view" or set FWA_POINTS_CSV_URL.`
    );
  }
  const rows = parseCsv(await response.text());
  if (rows.length === 0) return pointsCache;

  const headers = rows[0].map(normalizeHeader);
  const tagIdx = headers.findIndex((h) => h === 'clantag');
  const pointsIdx = headers.findIndex((h) => h === 'clanpoints');
  if (tagIdx === -1 || pointsIdx === -1) {
    throw new Error('FWA Points sheet needs "Clan Tag" and "Clan Points" columns.');
  }

  const next = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const tag = (rows[i][tagIdx] || '').trim().toUpperCase();
    if (!tag) continue;
    next.set(tag.startsWith('#') ? tag : `#${tag}`, parseInt(rows[i][pointsIdx], 10) || 0);
  }
  pointsCache = next;
  pointsCacheAt = Date.now();
  return pointsCache;
}

export function lookupPoints(points: Map<string, number>, tag: string): number {
  return points.get(tag.trim().toUpperCase()) ?? 0;
}
