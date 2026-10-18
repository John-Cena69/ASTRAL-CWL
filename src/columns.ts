import type { ColumnConfig } from '@/types';

export const DEFAULT_COLUMNS: ColumnConfig[] = [
  { key: 'playerName', label: 'Player Name', copyLabel: 'Player Names', visible: true, sortable: true },
  { key: 'playerTag', label: 'Player Tag', copyLabel: 'Player Tags', visible: true, sortable: true },
  { key: 'discordId', label: 'Discord ID', copyLabel: 'Discord IDs', visible: true, sortable: true },
  { key: 'townHall', label: 'Town Hall', copyLabel: 'Town Halls', visible: true, sortable: true },
  { key: 'warWeight', label: 'War Weight', copyLabel: 'War Weights', visible: true, sortable: true },
  { key: 'homeClan', label: 'Home Clan', copyLabel: 'Home Clans', visible: true, sortable: true },
  { key: 'status', label: 'Status', copyLabel: 'Statuses', visible: true, sortable: true },
];
