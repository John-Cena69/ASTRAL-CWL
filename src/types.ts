export interface Player {
  playerName: string;
  playerTag: string;
  discordId: string;
  townHall: number;
  warWeight: number;
  homeClan: string;
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
