import type { Clan, Player } from '@/types';

function parseCSV(text: string): string[][] {
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
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        current.push(field);
        field = '';
      } else if (char === '\n') {
        current.push(field);
        rows.push(current);
        current = [];
        field = '';
      } else if (char === '\r') {
        // skip carriage return
      } else {
        field += char;
      }
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

const HEADER_MAP: Record<string, keyof Player> = {
  playername: 'playerName',
  name: 'playerName',
  playertag: 'playerTag',
  tag: 'playerTag',
  discordid: 'discordId',
  discord: 'discordId',
  townhall: 'townHall',
  th: 'townHall',
  warweight: 'warWeight',
  weight: 'warWeight',
  homeclan: 'homeClan',
  clan: 'homeClan',
  status: 'status',
};

function mapRow(row: string[], headers: string[]): Player {
  const player: Player = {
    playerName: '',
    playerTag: '',
    discordId: '',
    townHall: 0,
    warWeight: 0,
    homeClan: '',
    status: '',
  };
  headers.forEach((h, i) => {
    const key = HEADER_MAP[normalizeHeader(h)];
    if (!key) return;
    const value = (row[i] || '').trim();
    if (key === 'townHall') {
      player[key] = parseInt(value, 10) || 0;
    } else if (key === 'warWeight') {
      player[key] = parseFloat(value) || 0;
    } else {
      player[key] = value;
    }
  });
  return player;
}

export function parseClanCSV(csv: string, clanName: string, clanTag: string): Clan {
  const rows = parseCSV(csv);
  if (rows.length === 0) {
    return { clanName, clanTag, players: [] };
  }
  const headers = rows[0];
  const players = rows.slice(1).map((r) => mapRow(r, headers));
  return { clanName, clanTag, players };
}

export function parseMultiClanCSV(csv: string): Clan[] {
  const rows = parseCSV(csv);
  if (rows.length === 0) return [];

  const headers = rows[0];
  const homeClanIdx = headers.findIndex((h) => normalizeHeader(h) === 'homeclan');
  const cwlClanIdx = headers.findIndex((h) => normalizeHeader(h) === 'cwlclan');
  const clanTagIdx = headers.findIndex((h) => normalizeHeader(h) === 'cwlclantag');
  const clanNameIdx = headers.findIndex((h) => normalizeHeader(h) === 'clanname');

  if (cwlClanIdx === -1 && homeClanIdx === -1) return [];

  const clanMap = new Map<string, Clan>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const player = mapRow(row, headers);
    const groupName = (row[cwlClanIdx !== -1 ? cwlClanIdx : homeClanIdx] || '').trim();
    if (!groupName) continue;

    let clanTag = '';
    if (clanTagIdx !== -1) clanTag = (row[clanTagIdx] || '').trim();
    else if (clanNameIdx !== -1) clanTag = (row[clanNameIdx] || '').trim();

    if (!clanMap.has(groupName)) {
      clanMap.set(groupName, {
        clanName: groupName,
        clanTag: clanTag || '',
        players: [],
      });
    }
    clanMap.get(groupName)!.players.push(player);
  }

  return Array.from(clanMap.values());
}
