import type { Clan } from '@/types';
import { parseClanCSV, parseMultiClanCSV } from '@/csvParser';

export interface SheetConfig {
  sheetId: string;
  gid?: string;
}

function extractSheetId(input: string): SheetConfig | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith('http')) {
    return { sheetId: trimmed };
  }

  const idMatch = trimmed.match(/\/d\/([a-zA-Z0-9-_]+)/);
  const gidMatch = trimmed.match(/[#&?]gid=([0-9]+)/);

  if (!idMatch) return null;
  return {
    sheetId: idMatch[1],
    gid: gidMatch ? gidMatch[1] : undefined,
  };
}

function buildCsvUrl(config: SheetConfig): string {
  let url = `https://docs.google.com/spreadsheets/d/${config.sheetId}/export?format=csv`;
  if (config.gid) url += `&gid=${config.gid}`;
  return url;
}

export interface FetchResult {
  clans: Clan[];
  warning?: string;
}

export async function fetchClansFromSheet(
  input: string,
  clanName: string,
  clanTag: string
): Promise<FetchResult> {
  const config = extractSheetId(input);
  if (!config) {
    throw new Error('Could not parse the Google Sheet URL or ID. Please check the input.');
  }

  const url = buildCsvUrl(config);

  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new Error(
      'Network error: Could not reach Google Sheets. If the sheet is private, you may need to make it "Anyone with link can view".'
    );
  }

  if (!response.ok) {
    throw new Error(
      `Google Sheets returned an error (status ${response.status}). Make sure the sheet exists and is publicly viewable.`
    );
  }

  const csv = await response.text();

  if (clanName.trim() && clanTag.trim()) {
    const clan = parseClanCSV(csv, clanName.trim(), clanTag.trim());
    return { clans: [clan] };
  }

  const clans = parseMultiClanCSV(csv);
  if (clans.length === 0) {
    return {
      clans: [],
      warning:
        'No "Home Clan" column found. Provide a Clan Name and Tag above to load the sheet as a single clan.',
    };
  }
  return { clans };
}
