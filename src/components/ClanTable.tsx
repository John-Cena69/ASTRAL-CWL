import { useState, useMemo } from 'react';
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Copy,
  Check,
  Users,
  Swords,
  Home,
  Shield,
  Hash,
  Gamepad2,
  Activity,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { Clan, ColumnConfig, ColumnKey, SortState } from '@/types';
import { buildClanMissingMentions, formatDiscordMention } from '@/discordMentions';

interface ClanTableProps {
  clan: Clan;
  columns: ColumnConfig[];
  onSort: (column: ColumnKey) => void;
  sortState: SortState | null;
  searchQuery: string;
  hidden: boolean;
  onToggleHide: () => void;
  spun: boolean;
  onToggleSpun: () => void;
}

const STATUS_STYLES: Record<string, string> = {
  'In CWL Clan': 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'In Wrong CWL Clan': 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  'In Home Clan': 'bg-astral-500/15 text-astral-300 border-astral-500/30',
  'In Other Clan': 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  Unregistered: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
};

const COLUMN_ICONS: Record<ColumnKey, typeof Users> = {
  playerName: Gamepad2,
  playerTag: Hash,
  discordId: Users,
  townHall: Home,
  warWeight: Swords,
  homeClan: Shield,
  status: Activity,
};

function TownHallBadge({ level }: { level: number }) {
  const color =
    level >= 16
      ? 'from-gold-300 to-gold-500'
      : level >= 13
      ? 'from-astral-300 to-astral-500'
      : 'from-slate-300 to-slate-500';
  return (
    <span
      className={`inline-flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br ${color} text-space-900 font-bold text-sm shadow-md`}
      title={`Town Hall ${level}`}
    >
      {level}
    </span>
  );
}

function CellCopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!value.trim()) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-astral-700/30"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-emerald-400" />
      ) : (
        <Copy className="w-3.5 h-3.5 text-astral-300/60 hover:text-gold-400" />
      )}
    </button>
  );
}

function SummaryCopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!value.trim()) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 text-xs text-astral-300/60 hover:text-gold-300 transition"
      title={`Copy ${label}`}
      disabled={!value.trim()}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-emerald-400" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

export default function ClanTable({
  clan,
  columns,
  onSort,
  sortState,
  searchQuery,
  hidden,
  onToggleHide,
  spun,
  onToggleSpun,
}: ClanTableProps) {
  const visibleColumns = columns.filter((c) => c.visible);

  const filteredPlayers = useMemo(() => {
    if (!searchQuery.trim()) return clan.players;
    const q = searchQuery.toLowerCase();
    return clan.players.filter((p) =>
      visibleColumns.some((col) => {
        const val = p[col.key];
        return String(val).toLowerCase().includes(q);
      })
    );
  }, [clan.players, searchQuery, visibleColumns]);

  const sortedPlayers = useMemo(() => {
    const sorted = [...filteredPlayers];
    if (sortState) {
      const { column, direction } = sortState;
      sorted.sort((a, b) => {
        const aVal = a[column];
        const bVal = b[column];
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return direction === 'asc' ? aVal - bVal : bVal - aVal;
        }
        return direction === 'asc'
          ? String(aVal).localeCompare(String(bVal))
          : String(bVal).localeCompare(String(aVal));
      });
    }
    return sorted;
  }, [filteredPlayers, sortState]);

  const getSortIcon = (column: ColumnKey) => {
    if (!sortState || sortState.column !== column) {
      return <ArrowUpDown className="w-3.5 h-3.5 opacity-30" />;
    }
    return sortState.direction === 'asc' ? (
      <ArrowUp className="w-3.5 h-3.5 text-gold-400" />
    ) : (
      <ArrowDown className="w-3.5 h-3.5 text-gold-400" />
    );
  };

  const cwlCount = clan.players.filter((p) => p.status === 'In CWL Clan').length;
  const wrongCount = clan.players.filter((p) => p.status === 'In Wrong CWL Clan').length;
  const unregisteredCount = clan.players.filter((p) => p.status === 'Unregistered').length;

  return (
    <div className="astral-card overflow-hidden">
      {/* Clan header */}
      <div className="relative px-6 py-5 border-b border-astral-700/30 bg-gradient-to-r from-space-700/50 to-space-800/30">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-astral-500 to-astral-700 flex items-center justify-center shadow-lg shadow-astral-900/50 animate-float">
              <Shield className="w-6 h-6 text-gold-300" />
            </div>
            <div>
              <h3 className="font-display text-xl sm:text-2xl font-bold text-white">
                {clan.clanName}
              </h3>
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-gold-400/80 font-medium">{clan.clanTag}</p>
                <SummaryCopyButton value={clan.clanTag} label="Copy Tag" />
                <SummaryCopyButton
                  value={`https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodeURIComponent(clan.clanTag)}`}
                  label="Copy Link"
                />
                <SummaryCopyButton
                  value={buildClanMissingMentions(clan)}
                  label="Copy Missing"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-astral-200 cursor-pointer">
              <input
                type="checkbox"
                checked={spun}
                onChange={onToggleSpun}
                className="h-4 w-4 accent-gold-400"
              />
              <span>CWL Spun</span>
            </label>
            <div className="flex items-center gap-1.5 text-astral-200">
              <Activity className="w-4 h-4 text-emerald-400" />
              <span className="font-semibold text-white">{cwlCount}</span>
              <span className="text-astral-300/60">in CWL</span>
            </div>
            <div className="flex items-center gap-1.5 text-astral-200">
              <Activity className="w-4 h-4 text-rose-400" />
              <span className="font-semibold text-white">{wrongCount}</span>
              <span className="text-astral-300/60">wrong</span>
            </div>
            <div className="flex items-center gap-1.5 text-astral-200">
              <Users className="w-4 h-4 text-slate-400" />
              <span className="font-semibold text-white">{unregisteredCount}</span>
              <span className="text-astral-300/60">unregistered</span>
            </div>
            <button
              onClick={onToggleHide}
              className="astral-btn-ghost text-xs px-2.5 py-1.5"
              title={hidden ? 'Show table' : 'Hide table'}
            >
              {hidden ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronUp className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">{hidden ? 'Show' : 'Hide'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      {hidden ? (
        <div className="px-6 py-4 text-sm text-astral-300/40 text-center">
          Table hidden. Click the arrow above to expand.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-space-700/40">
                <th className="px-4 py-3 text-left text-astral-300/60 font-medium w-12">
                  #
                </th>
                {visibleColumns.map((col) => {
                  const Icon = COLUMN_ICONS[col.key];
                  return (
                    <th
                      key={col.key}
                      className="px-4 py-3 text-left font-semibold text-astral-100 whitespace-nowrap"
                    >
                      {col.sortable ? (
                        <button
                          onClick={() => onSort(col.key)}
                          className="flex items-center gap-1.5 hover:text-gold-300 transition group"
                        >
                          <Icon className="w-4 h-4 text-astral-400 group-hover:text-gold-400" />
                          {col.label}
                          {getSortIcon(col.key)}
                        </button>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <Icon className="w-4 h-4 text-astral-400" />
                          {col.label}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedPlayers.length === 0 ? (
                <tr>
                  <td
                    colSpan={visibleColumns.length + 2}
                    className="px-4 py-12 text-center text-astral-300/50"
                  >
                    No players match your search.
                  </td>
                </tr>
              ) : (
                sortedPlayers.map((player, idx) => (
                  <tr
                    key={player.playerTag || player.discordId || `${player.playerName}-${idx}`}
                    className="border-t border-astral-700/15 hover:bg-astral-700/10 transition-colors group"
                  >
                    <td className="px-4 py-3 text-astral-300/40 font-mono text-xs">
                      {idx + 1}
                    </td>
                    {visibleColumns.map((col) => (
                      <td
                        key={col.key}
                        className="px-4 py-3 whitespace-nowrap"
                      >
                        {col.key === 'townHall' ? (
                          <TownHallBadge level={player.townHall} />
                        ) : col.key === 'warWeight' ? (
                          <span className="font-mono text-gold-300 font-medium">
                            {player.warWeight}
                          </span>
                        ) : col.key === 'status' ? (
                          <div className="flex flex-col items-start gap-1">
                            <span
                              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${
                                STATUS_STYLES[player.status] ||
                                'bg-astral-500/15 text-astral-300 border-astral-500/30'
                              }`}
                            >
                              {player.status || '—'}
                            </span>
                            {(player.status === 'In Other Clan' ||
                              player.status === 'In Wrong CWL Clan') &&
                              player.presentClan && (
                                <span className="text-xs text-astral-300/70">
                                  {player.presentClan}
                                </span>
                              )}
                          </div>
                        ) : col.key === 'playerTag' ? (
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-astral-200">
                              {player[col.key] || '—'}
                            </span>
                            {player[col.key] && <CellCopyButton value={player[col.key]} />}
                          </div>
                        ) : col.key === 'discordId' ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-astral-100">
                              {player[col.key] || '—'}
                            </span>
                            {player[col.key] && (
                              <CellCopyButton value={formatDiscordMention(player[col.key])} />
                            )}
                          </div>
                        ) : (
                          <span className="text-astral-100">
                            {player[col.key] || '—'}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      {!hidden && (
        <div className="px-6 py-3 bg-space-900/40 border-t border-astral-700/20 text-xs text-astral-300/50">
          Showing {sortedPlayers.length} of {clan.players.length} players
        </div>
      )}
    </div>
  );
}
