export interface Player {
  playerName: string;
  playerTag: string;
  discordId: string;
  townHall: number;
  warWeight: number;
  homeClan: string;
  presentClan: string;
  status: string;
}

export interface Clan {
  clanName: string;
  clanTag: string;
  players: Player[];
}

export type ColumnKey =
  | 'playerName'
  | 'playerTag'
  | 'discordId'
  | 'townHall'
  | 'warWeight'
  | 'homeClan'
  | 'status';

export type PageKey = 'roster' | 'accounts' | 'wars' | 'clans' | 'developer';

export type ClanPageKey = 'home' | 'war-weights' | 'strike-board' | 'strike-manager';

export interface ClanPage {
  type: 'clan';
  clanTag: string;
  clanName: string;
  page: ClanPageKey;
}

export type ActivePage = PageKey | ClanPage;

export interface ColumnConfig {
  key: ColumnKey;
  label: string;
  copyLabel: string;
  visible: boolean;
  sortable: boolean;
}

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  column: ColumnKey;
  direction: SortDirection;
}

export interface TrackedClan {
  clan_tag: string;
  clan_name: string;
  added_date?: string;
}

export interface ClanRosterPlayer {
  id: string;
  player_name: string;
  player_tag: string;
  discord_id: string | null;
  town_hall: number | null;
  role: string | null;
  status: string | null;
  join_date: string | null;
  days_in_clan: number | null;
  war_weight: number | null;
  updated_date: string | null;
}

export interface ClanWarWeight {
  id: string;
  player_name: string;
  player_tag: string;
  town_hall: number | null;
  value: number | null;
  war_weight: number | null;
  map_position: number | null;
  updated_date: string | null;
}

export const ROLE_OPTIONS: string[] = [
  'Leader',
  'Rep',
  'Co-Leader',
  'Staff',
  'Elder',
  'Member',
  'Filler',
];

export function isClanPage(page: ActivePage): page is ClanPage {
  return (page as ClanPage).type === 'clan';
}

export function clanPageKey(tag: string, name: string, page: ClanPageKey): ClanPage {
  return { type: 'clan', clanTag: tag, clanName: name, page };
}

export function clanPageId(page: ClanPage): string {
  return `clan-${page.page}:${page.clanTag}`;
}
