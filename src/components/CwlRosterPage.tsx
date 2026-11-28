import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import { compareClansByLeague } from '@/cwlLeague';

interface Season {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  closed_by: string | null;
  closed_at: string | null;
}

interface CwlClan {
  clan_tag: string;
  clan_name: string | null;
  cwl_league: string | null;
  badge_url: string | null;
}

interface SeasonClan {
  id: string;
  clan_tag: string;
  roster_size: number;
  role_id: string | null;
  added_by: string | null;
  added_at: string;
}

interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

interface Entry {
  id: string;
  player_name: string;
  player_tag: string;
  discord_id: string | null;
  war_weight: number | null;
  notes: string | null;
  home_clan: string | null;
  cwl_clan_tag: string | null;
  cwl_clan_name: string | null;
  cwl_assigned_at: string | null;
  status: string | null;
  current_clan: string | null;
  created_date: string;
}

interface UnregisteredEntry {
  id: string;
  player_name: string;
  player_tag: string;
  discord_id: string | null;
  current_clan: string | null;
  cwl_clan_tag: string | null;
  status: string;
  updated_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  'In CWL Clan': 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'In Wrong CWL Clan': 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  'In Home Clan': 'bg-astral-500/15 text-astral-300 border-astral-500/30',
  'In Other Clan': 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  Unregistered: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  'Leader - Unregistered': 'bg-amber-500/15 text-amber-300 border-amber-500/30',
};

interface RosterData {
  season: Season | null;
  past_seasons: Season[];
  clans: CwlClan[];
  season_clans: SeasonClan[];
  discord_roles?: DiscordRole[];
  entries: Entry[];
  unregistered?: UnregisteredEntry[];
  warning: string | null;
}

function normTag(value: string | null | undefined): string {
  const cleaned = (value ?? '').trim().toUpperCase().replace(/^#+/, '');
  return cleaned ? `#${cleaned}` : '';
}

function roleColorHex(color: number): string {
  return color > 0 ? `#${color.toString(16).padStart(6, '0')}` : '#99aab5';
}

function Modal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function byWeightDesc(a: Entry, b: Entry): number {
  if (a.war_weight === null && b.war_weight === null) return a.player_name.localeCompare(b.player_name);
  if (a.war_weight === null) return 1;
  if (b.war_weight === null) return -1;
  return b.war_weight - a.war_weight || a.player_name.localeCompare(b.player_name);
}

function byAssignment(a: Entry, b: Entry): number {
  const at = new Date(a.cwl_assigned_at ?? a.created_date).getTime();
  const bt = new Date(b.cwl_assigned_at ?? b.created_date).getTime();
  return at - bt || new Date(a.created_date).getTime() - new Date(b.created_date).getTime();
}

type Confirm = { kind: 'autofill'; clan: CwlClan; players: Entry[] };

interface AddPlayersModalProps {
  clanLabel: string;
  badgeUrl: string | null;
  slotsLeft: number;
  rosterSize: number;
  entries: Entry[];
  onClose: () => void;
  onSubmit: (ids: string[]) => void;
}

function AddPlayersModal({
  clanLabel,
  badgeUrl,
  slotsLeft,
  rosterSize,
  entries,
  onClose,
  onSubmit,
}: AddPlayersModalProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const { body, documentElement } = document;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      document.removeEventListener('keydown', onKey);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
    };
  }, []);

  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const q = query.trim().toLowerCase().replace(/^#/, '');
  const matches = (entry: Entry) =>
    !q ||
    entry.player_name.toLowerCase().includes(q) ||
    entry.player_tag.toLowerCase().replace(/^#/, '').includes(q);
  const available = entries.filter((entry) => !entry.cwl_clan_tag && matches(entry)).sort(byWeightDesc);
  const alreadyAssigned = q
    ? entries.filter((entry) => !!entry.cwl_clan_tag && matches(entry)).sort(byWeightDesc)
    : [];
  const totalUnassigned = entries.filter((entry) => !entry.cwl_clan_tag).length;

  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const key = entry.player_name.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [entries]);
  const isDuplicateName = (entry: Entry) =>
    (nameCounts.get(entry.player_name.trim().toLowerCase()) ?? 0) > 1;

  const remaining = slotsLeft - selected.length;
  const atLimit = remaining <= 0;

  const toggle = (id: string) => {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= slotsLeft) return current;
      return [...current, id];
    });
  };

  const selectVisibleTop = () => {
    setSelected((current) => {
      const next = [...current];
      for (const entry of available) {
        if (next.length >= slotsLeft) break;
        if (!next.includes(entry.id)) next.push(entry.id);
      }
      return next;
    });
  };

  const submit = () => {
    if (selected.length === 0) return;
    onSubmit(selected);
  };

  const weightText = (entry: Entry) =>
    entry.war_weight != null ? entry.war_weight.toLocaleString() : 'No weight';

  return (
    <Modal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label={`Add players to ${clanLabel}`}
      >
        <div
          className="absolute inset-0 bg-space-950/75 backdrop-blur-sm"
          onClick={onClose}
          aria-hidden="true"
        />
        <div className="relative flex flex-col w-full max-w-2xl max-h-[88vh] bg-space-800 border border-astral-700/30 rounded-2xl shadow-2xl shadow-space-950 overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-astral-700/20">
            {badgeUrl ? (
              <img src={badgeUrl} alt="" className="w-10 h-10 object-contain shrink-0" />
            ) : (
              <Shield className="w-9 h-9 text-astral-300/50 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <h3 className="font-display text-lg font-bold text-white truncate">
                Add players to {clanLabel}
              </h3>
              <p className="text-xs text-astral-300/60">
                {slotsLeft} of {rosterSize} slots open · {totalUnassigned} unassigned player
                {totalUnassigned === 1 ? '' : 's'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-astral-300/70 hover:text-white hover:bg-white/5 rounded-lg"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Search + quick actions */}
          <div className="px-5 pt-4 space-y-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-astral-300/50" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name or tag..."
                className="astral-input w-full pl-9 pr-9"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-astral-300/60 hover:text-white rounded"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-astral-300/60">
                {available.length} available{q ? ' for this search' : ''} · sorted by war weight
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={selectVisibleTop}
                  disabled={atLimit || available.every((entry) => selected.includes(entry.id))}
                  className="text-gold-300 hover:text-gold-200 disabled:text-astral-300/30 disabled:cursor-not-allowed"
                >
                  Select top{' '}
                  {Math.max(
                    0,
                    Math.min(remaining, available.filter((entry) => !selected.includes(entry.id)).length)
                  )}
                </button>
                {selected.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelected([])}
                    className="text-astral-300/60 hover:text-white"
                  >
                    Clear selection
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Player list */}
          <div className="flex-1 min-h-[12rem] overflow-y-auto overscroll-contain px-3 py-3">
            {available.length === 0 && alreadyAssigned.length === 0 ? (
              <div className="py-12 text-center">
                <Users className="w-8 h-8 mx-auto text-astral-300/30" />
                <p className="mt-3 text-sm text-astral-300/60">
                  {q ? 'No players match your search.' : 'Every signed-up player is already assigned.'}
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {available.length === 0 && alreadyAssigned.length > 0 && (
                  <li className="mx-2 mb-2 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    <AlertCircle className="w-4 h-4 shrink-0" /> Every player matching &ldquo;
                    {query.trim()}&rdquo; is already assigned to a clan.
                  </li>
                )}
                {available.map((entry) => {
                  const checked = selected.includes(entry.id);
                  const blocked = !checked && atLimit;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => toggle(entry.id)}
                        disabled={blocked}
                        aria-pressed={checked}
                        className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition border ${
                          checked
                            ? 'border-gold-400/50 bg-gold-500/10'
                            : blocked
                              ? 'border-transparent opacity-40 cursor-not-allowed'
                              : 'border-transparent hover:bg-white/5'
                        }`}
                        title={blocked ? 'No slots left — deselect someone first' : undefined}
                      >
                        <span
                          className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition ${
                            checked
                              ? 'border-gold-400 bg-gold-400 text-space-900'
                              : 'border-astral-300/40'
                          }`}
                        >
                          {checked && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-sm font-medium text-white">
                            {entry.player_name}
                          </span>
                          <span className="flex items-center gap-2 text-xs">
                            <span
                              className={`font-mono ${
                                isDuplicateName(entry) ? 'text-gold-300 font-semibold' : 'text-gold-400/70'
                              }`}
                            >
                              {entry.player_tag}
                            </span>
                            {entry.home_clan && (
                              <span className="truncate text-astral-300/50">· {entry.home_clan}</span>
                            )}
                          </span>
                        </span>
                        <span
                          className={`text-sm tabular-nums shrink-0 ${
                            entry.war_weight != null ? 'text-astral-100' : 'text-astral-300/40'
                          }`}
                        >
                          {weightText(entry)}
                        </span>
                        {checked && (
                          <span className="w-6 h-6 rounded-full bg-gold-400/20 text-gold-200 text-[11px] font-bold flex items-center justify-center shrink-0">
                            {selected.indexOf(entry.id) + 1}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
                {alreadyAssigned.length > 0 && (
                  <>
                    <li className="px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-300/80">
                      Already assigned ({alreadyAssigned.length})
                    </li>
                    {alreadyAssigned.map((entry) => (
                      <li key={entry.id}>
                        <div
                          className="flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 cursor-not-allowed"
                          title={`Already in ${entry.cwl_clan_name ?? entry.cwl_clan_tag}`}
                        >
                          <AlertCircle className="w-5 h-5 text-amber-300 shrink-0" />
                          <span className="flex-1 min-w-0">
                            <span className="block truncate text-sm font-medium text-amber-100">
                              {entry.player_name}
                            </span>
                            <span className="block truncate text-xs">
                              <span className="font-mono text-amber-300/70">{entry.player_tag}</span>
                              <span className="text-amber-200/60">
                                {' '}
                                · in {entry.cwl_clan_name ?? entry.cwl_clan_tag}
                              </span>
                            </span>
                          </span>
                          <span className="text-sm tabular-nums text-amber-200/50 shrink-0">
                            {weightText(entry)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </>
                )}
              </ul>
            )}
          </div>

          {/* Selected tray + footer */}
          <div className="border-t border-astral-700/20 bg-space-900/40 px-5 py-4 space-y-3">
            {selected.length > 0 && (
              <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto overscroll-contain">
                {selected.map((id) => {
                  const entry = byId.get(id);
                  if (!entry) return null;
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 rounded-full border border-gold-400/30 bg-gold-500/10 pl-2.5 pr-1 py-0.5 text-xs text-gold-100"
                    >
                      {entry.player_name}
                      <button
                        type="button"
                        onClick={() => toggle(id)}
                        className="p-0.5 rounded-full hover:bg-white/10"
                        aria-label={`Remove ${entry.player_name}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[10rem]">
                <div className="text-sm text-white">
                  <span className="font-semibold">{selected.length}</span> selected
                  <span className="text-astral-300/60">
                    {' '}
                    · {remaining} slot{remaining === 1 ? '' : 's'} left after adding
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-astral-700/30 overflow-hidden">
                  <div
                    className="h-full bg-gold-400 transition-all"
                    style={{
                      width: `${
                        rosterSize > 0
                          ? Math.min(100, ((rosterSize - slotsLeft + selected.length) / rosterSize) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
              <button type="button" onClick={onClose} className="astral-btn-ghost">
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={selected.length === 0}
                className="astral-btn-primary disabled:opacity-50"
              >
                <UserPlus className="w-4 h-4" />
                {selected.length === 0
                  ? 'Add players'
                  : `Add ${selected.length} player${selected.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default function CwlRosterPage({ canEdit = true }: { canEdit?: boolean }) {
  const [data, setData] = useState<RosterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [collapsedRosters, setCollapsedRosters] = useState<Set<string>>(() => new Set());

  const request = async (method: 'GET' | 'POST', payload?: Record<string, unknown>) => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const response = await fetch('/api/cwl-roster', {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
      ok?: boolean;
      error?: string;
    };
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const body = (await request('GET')) as unknown as RosterData;
      setData(body);
      if (body.warning && !silent) setMessage(body.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roster.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (payload: Record<string, unknown>, success?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await request('POST', payload);
      if (success) setMessage(success);
      await load(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
      await load(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const clanByTag = useMemo(
    () => new Map((data?.clans ?? []).map((clan) => [clan.clan_tag, clan])),
    [data]
  );

  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [savingClans, setSavingClans] = useState<Set<string>>(() => new Set());
  const pendingOps = useRef(0);

  const markSaving = (tag: string, on: boolean) => {
    setSavingClans((current) => {
      const next = new Set(current);
      if (on) next.add(tag);
      else next.delete(tag);
      return next;
    });
  };

  const runOptimistic = async (
    clanTag: string,
    mutate: (entries: Entry[]) => Entry[],
    payload: Record<string, unknown>,
    success?: string
  ) => {
    setError(null);
    setData((prev) => (prev ? { ...prev, entries: mutate(prev.entries) } : prev));
    pendingOps.current += 1;
    markSaving(clanTag, true);
    try {
      const body = await request('POST', payload);
      const skipped = typeof body.skipped === 'number' ? body.skipped : 0;
      if (skipped > 0)
        setMessage(
          `${success ?? 'Saved.'} ${skipped} player(s) were skipped because someone else assigned them first.`
        );
      else if (success) setMessage(success);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      pendingOps.current -= 1;
      markSaving(clanTag, false);
      if (pendingOps.current === 0) void load(true);
    }
  };

  const assignPlayers = (clanTag: string, ids: string[]) => {
    const clan = clanByTag.get(clanTag);
    const base = Date.now();
    const label = clan?.clan_name ?? clanTag;
    void runOptimistic(
      clanTag,
      (entries) =>
        entries.map((entry) => {
          const index = ids.indexOf(entry.id);
          return index >= 0 && !entry.cwl_clan_tag
            ? {
                ...entry,
                cwl_clan_tag: clanTag,
                cwl_clan_name: clan?.clan_name ?? null,
                cwl_assigned_at: new Date(base + index).toISOString(),
              }
            : entry;
        }),
      { action: 'assign_many', clan_tag: clanTag, entry_ids: ids },
      `Added ${ids.length} player${ids.length === 1 ? '' : 's'} to ${label}.`
    );
  };

  const unassignPlayer = (entry: Entry) => {
    if (!entry.cwl_clan_tag) return;
    void runOptimistic(
      entry.cwl_clan_tag,
      (entries) =>
        entries.map((item) =>
          item.id === entry.id
            ? { ...item, cwl_clan_tag: null, cwl_clan_name: null, cwl_assigned_at: null }
            : item
        ),
      { action: 'unassign', entry_id: entry.id }
    );
  };

  const sortedSeasonClans = useMemo(() => {
    return [...(data?.season_clans ?? [])].sort((a, b) => {
      const ca = clanByTag.get(a.clan_tag) ?? { cwl_league: null, clan_name: a.clan_tag };
      const cb = clanByTag.get(b.clan_tag) ?? { cwl_league: null, clan_name: b.clan_tag };
      return compareClansByLeague(ca, cb);
    });
  }, [data, clanByTag]);

  const unassigned = useMemo(
    () => (data?.entries ?? []).filter((entry) => !entry.cwl_clan_tag),
    [data]
  );

  const toggleRosterCollapsed = (tag: string) => {
    setCollapsedRosters((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const runConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === 'autofill') {
      assignPlayers(
        confirm.clan.clan_tag,
        confirm.players.map((player) => player.id)
      );
      setConfirm(null);
    }
  };

  const season = data?.season ?? null;
  const discordRolesById = useMemo(
    () => new Map((data?.discord_roles ?? []).map((r) => [r.id, r])),
    [data]
  );

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-36 space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">CWL Roster</h2>
          </div>
          {season ? (
            <p className="mt-1 text-sm text-astral-300/60">
              <span className="font-semibold text-gold-300">{season.name}</span> · started by{' '}
              {season.created_by ?? 'unknown'} on {formatDate(season.created_at)}
            </p>
          ) : (
            <p className="mt-1 text-sm text-astral-300/60">
              No active season. Manage seasons and role mappings on the CWL Dashboard.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {season && (
            <div className="inline-flex items-center gap-2 rounded-xl border border-astral-700/40 bg-space-900/60 px-3.5 py-2 text-xs font-medium text-astral-200">
              <span>
                <span className="text-white font-semibold tabular-nums">{unassigned.length}</span> unassigned
                player{unassigned.length === 1 ? '' : 's'}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="astral-btn-ghost text-xs"
            title="Refresh rosters"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {(error || message) && (
        <div
          className={`p-4 rounded-xl border text-sm flex items-start gap-3 ${
            error
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
          }`}
        >
          {error && <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />}
          <p className="flex-1">{error || message}</p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMessage(null);
            }}
            className="p-1 rounded-lg opacity-60 hover:opacity-100 hover:bg-white/10 transition shrink-0"
            title="Dismiss"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="astral-card p-12 text-center text-astral-300/60">
          <LoaderCircle className="w-6 h-6 animate-spin mx-auto" />
          <p className="mt-3 text-sm">Loading roster...</p>
        </div>
      ) : !season ? (
        <div className="astral-card p-10 text-center">
          <Shield className="w-8 h-8 mx-auto text-astral-300/40" />
          <p className="mt-3 font-medium text-astral-100">No active CWL season</p>
          <p className="mt-1 text-sm text-astral-300/60">
            Start a new season and select participating clans on the <span className="text-gold-300 font-medium">CWL Dashboard</span>.
          </p>
        </div>
      ) : (
        <>
          {sortedSeasonClans.length === 0 && (
            <div className="astral-card p-8 text-center text-sm text-astral-300/60">
              No clans selected for <span className="text-white font-medium">{season.name}</span> yet. Select clans for this season on the{' '}
              <span className="text-gold-300 font-medium">CWL Dashboard</span> to start building rosters.
            </div>
          )}

          {sortedSeasonClans.length > 1 && (
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() =>
                  setCollapsedRosters(new Set(sortedSeasonClans.map((sc) => sc.clan_tag)))
                }
                className="text-xs text-astral-300/60 hover:text-white underline underline-offset-2"
              >
                Minimise all clans
              </button>
              <span className="text-astral-300/30 text-xs">·</span>
              <button
                type="button"
                onClick={() => setCollapsedRosters(new Set())}
                className="text-xs text-astral-300/60 hover:text-white underline underline-offset-2"
              >
                Expand all
              </button>
            </div>
          )}

          {sortedSeasonClans.map((sc) => {
            const clan = clanByTag.get(sc.clan_tag);
            const roster = (data?.entries ?? [])
              .filter((entry) => entry.cwl_clan_tag === sc.clan_tag)
              .sort(byAssignment);
            const rosterTags = new Set(roster.map((entry) => normTag(entry.player_tag)));
            const clanTagNorm = normTag(sc.clan_tag);
            const unregisteredInClan = (data?.unregistered ?? [])
              .filter(
                (item) =>
                  normTag(item.cwl_clan_tag) === clanTagNorm &&
                  !rosterTags.has(normTag(item.player_tag))
              )
              .sort((a, b) => {
                const aLeader = a.status.toLowerCase().includes('leader') ? 0 : 1;
                const bLeader = b.status.toLowerCase().includes('leader') ? 0 : 1;
                return aLeader - bLeader || a.player_name.localeCompare(b.player_name);
              });
            const missingWeightCount = roster.filter((entry) => entry.war_weight === null).length;
            const average =
              roster.length > 0
                ? Math.round(
                    roster.reduce((sum, entry) => sum + (entry.war_weight ?? 0), 0) / roster.length
                  )
                : null;
            const free = Math.max(0, sc.roster_size - roster.length);
            const full = roster.length >= sc.roster_size;
            const clanLabel = clan?.clan_name ?? sc.clan_tag;
            const fillers = [...unassigned].sort(byWeightDesc).slice(0, free);
            const isCollapsed = collapsedRosters.has(sc.clan_tag);
            const mappedRole = sc.role_id ? discordRolesById.get(sc.role_id) ?? null : null;

            return (
              <section key={sc.id} className="astral-card">
                <div
                  className={`p-5 flex flex-col lg:flex-row lg:items-center gap-4 ${
                    isCollapsed ? '' : 'border-b border-astral-700/20'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {clan?.badge_url ? (
                      <img src={clan.badge_url} alt="" className="w-12 h-12 object-contain shrink-0" />
                    ) : (
                      <Shield className="w-10 h-10 text-astral-300/50 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-display text-lg font-bold text-white truncate">
                          {clanLabel}
                        </h3>
                        {mappedRole && (
                          <span
                            className="inline-flex items-center gap-1.5 rounded-full border border-astral-700/40 bg-space-900/60 px-2.5 py-0.5 text-xs font-medium text-astral-100"
                            title={`Mapped Discord role: @${mappedRole.name}`}
                          >
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: roleColorHex(mappedRole.color) }}
                            />
                            @{mappedRole.name}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-astral-300/60 truncate">
                        {clan?.cwl_league ?? 'Unranked'} ·{' '}
                        <span className="font-mono">{sc.clan_tag}</span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-6 text-sm">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-astral-300/60">
                        Players
                      </div>
                      <div
                        className={`font-semibold tabular-nums ${
                          roster.length > sc.roster_size ? 'text-rose-300' : 'text-white'
                        }`}
                      >
                        {roster.length}/{sc.roster_size}
                      </div>
                    </div>
                    {unregisteredInClan.length > 0 && (
                      <div title="Players currently in this CWL clan who did not sign up">
                        <div className="text-xs uppercase tracking-wide text-astral-300/60">
                          Unregistered
                        </div>
                        <div className="font-semibold tabular-nums text-amber-300">
                          {unregisteredInClan.length}
                        </div>
                      </div>
                    )}
                    <div
                      title={
                        missingWeightCount > 0
                          ? `Average of assigned players (${missingWeightCount} player(s) without a weight counted as 0)`
                          : 'Average of assigned players'
                      }
                    >
                      <div className="text-xs uppercase tracking-wide text-astral-300/60">
                        Avg weight
                      </div>
                      <div className="font-semibold tabular-nums text-gold-300">
                        {average !== null ? average.toLocaleString() : '—'}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {canEdit && (
                      <>
                        <div
                          className="inline-flex rounded-xl border border-astral-700/40 p-0.5"
                          role="group"
                          aria-label="Roster size"
                        >
                          {[15, 30].map((size) => (
                            <button
                              key={size}
                              type="button"
                              disabled={busy || sc.roster_size === size}
                              onClick={() =>
                                void act({
                                  action: 'set_size',
                                  clan_tag: sc.clan_tag,
                                  roster_size: size,
                                })
                              }
                              className={`px-3 py-1.5 text-sm rounded-lg transition ${
                                sc.roster_size === size
                                  ? 'bg-gold-500/20 text-gold-200 font-semibold'
                                  : 'text-astral-200 hover:bg-white/5'
                              }`}
                            >
                              {size}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          disabled={fillers.length === 0}
                          onClick={() =>
                            clan && setConfirm({ kind: 'autofill', clan, players: fillers })
                          }
                          className="astral-btn-ghost disabled:opacity-40"
                          title={
                            full
                              ? `Roster is full (${roster.length}/${sc.roster_size})`
                              : unassigned.length === 0
                                ? 'No unassigned players left'
                                : 'Fill empty slots with the highest-weight unassigned players'
                          }
                        >
                          <Sparkles className="w-4 h-4" /> Auto-fill
                        </button>
                        <button
                          type="button"
                          disabled={full}
                          onClick={() => {
                            setError(null);
                            setMessage(null);
                            setAddingTo(sc.clan_tag);
                          }}
                          className={
                            full
                              ? 'astral-btn-ghost opacity-60 cursor-not-allowed'
                              : 'astral-btn-primary'
                          }
                          title={
                            full
                              ? `Roster is full (${roster.length}/${sc.roster_size}). Remove a player or switch to 30 to add more.`
                              : `Add players to ${clanLabel}`
                          }
                        >
                          {full ? <Check className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
                          {full
                            ? 'Roster full'
                            : `Add players${free < sc.roster_size ? ` (${free} open)` : ''}`}
                        </button>
                      </>
                    )}
                    {savingClans.has(sc.clan_tag) && (
                      <span
                        className="inline-flex items-center gap-1.5 text-xs text-astral-300/60"
                        aria-live="polite"
                      >
                        <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> Saving
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => toggleRosterCollapsed(sc.clan_tag)}
                      className="p-2 text-astral-300/70 hover:text-white hover:bg-white/5 rounded-lg"
                      title={isCollapsed ? `Expand ${clanLabel}` : `Minimise ${clanLabel}`}
                      aria-label={isCollapsed ? `Expand ${clanLabel}` : `Minimise ${clanLabel}`}
                      aria-expanded={!isCollapsed}
                    >
                      {isCollapsed ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronUp className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                {!isCollapsed &&
                  (roster.length === 0 && unregisteredInClan.length === 0 ? (
                    <div className="p-8 text-center">
                      <p className="text-sm text-astral-300/50">No players assigned yet.</p>
                      {unassigned.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setAddingTo(sc.clan_tag)}
                          className="mt-3 text-sm text-gold-300 hover:text-gold-200 underline underline-offset-2"
                        >
                          Pick from {unassigned.length} unassigned player
                          {unassigned.length === 1 ? '' : 's'}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-astral-700/20 text-astral-300/60">
                            <th className="px-4 py-3 text-left font-medium">#</th>
                            <th className="px-4 py-3 text-left font-medium">Name</th>
                            <th className="px-4 py-3 text-left font-medium">Tag</th>
                            <th className="px-4 py-3 text-left font-medium">Discord ID</th>
                            <th className="px-4 py-3 text-left font-medium">Clan</th>
                            <th className="px-4 py-3 text-right font-medium">War Weight</th>
                            <th className="px-4 py-3 text-left font-medium">Status</th>
                            <th className="px-4 py-3 text-left font-medium">Notes</th>
                            <th className="px-4 py-3" />
                          </tr>
                        </thead>
                        <tbody>
                          {roster.map((entry, index) => (
                            <tr
                              key={entry.id}
                              className="border-b border-astral-700/10 text-astral-100"
                            >
                              <td className="px-4 py-3 text-astral-300/60">{index + 1}</td>
                              <td className="px-4 py-3 font-medium text-white">
                                {entry.player_name}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-gold-300">
                                {entry.player_tag}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs">
                                {entry.discord_id || '—'}
                              </td>
                              <td className="px-4 py-3">{entry.cwl_clan_name || clanLabel}</td>
                              <td className="px-4 py-3 text-right tabular-nums">
                                {entry.war_weight != null
                                  ? entry.war_weight.toLocaleString()
                                  : '—'}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                {entry.status ? (
                                  <div className="flex flex-col items-start gap-1">
                                    <span
                                      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${
                                        STATUS_STYLES[entry.status] ||
                                        'bg-astral-500/15 text-astral-300 border-astral-500/30'
                                      }`}
                                    >
                                      {entry.status}
                                    </span>
                                    {(entry.status === 'In Other Clan' ||
                                      entry.status === 'In Wrong CWL Clan' ||
                                      entry.status === 'In Home Clan') &&
                                      entry.current_clan && (
                                        <span className="text-xs text-astral-300/70">
                                          {entry.current_clan}
                                        </span>
                                      )}
                                  </div>
                                ) : (
                                  <span className="text-astral-300/40">—</span>
                                )}
                              </td>
                              <td
                                className="px-4 py-3 max-w-xs truncate"
                                title={entry.notes ?? ''}
                              >
                                {entry.notes || '—'}
                              </td>
                              <td className="px-4 py-3 text-right">
                                {canEdit && (
                                  <button
                                    type="button"
                                    onClick={() => unassignPlayer(entry)}
                                    className="p-2 text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/10 rounded-lg"
                                    title="Unassign from this clan (keeps the CWL entry)"
                                    aria-label={`Unassign ${entry.player_name}`}
                                  >
                                    <X className="w-4 h-4" />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                          {unregisteredInClan.map((item) => (
                            <tr
                              key={`unreg-${item.id}`}
                              className="border-b border-astral-700/10 text-astral-100 bg-space-900/25"
                            >
                              <td className="px-4 py-3 text-astral-300/40">—</td>
                              <td className="px-4 py-3 font-medium text-white">
                                {item.player_name}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-gold-300">
                                {item.player_tag}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs">
                                {item.discord_id || '—'}
                              </td>
                              <td className="px-4 py-3">{item.current_clan || clanLabel}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-astral-300/40">
                                —
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                <span
                                  className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${
                                    STATUS_STYLES[item.status] ||
                                    'bg-slate-500/15 text-slate-300 border-slate-500/30'
                                  }`}
                                >
                                  {item.status}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-astral-300/40">—</td>
                              <td className="px-4 py-3" />
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
              </section>
            );
          })}
        </>
      )}

      {addingTo &&
        data &&
        (() => {
          const sc = data.season_clans.find((item) => item.clan_tag === addingTo);
          if (!sc) return null;
          const clan = clanByTag.get(addingTo);
          const assignedCount = data.entries.filter(
            (entry) => entry.cwl_clan_tag === addingTo
          ).length;
          return (
            <AddPlayersModal
              clanLabel={clan?.clan_name ?? addingTo}
              badgeUrl={clan?.badge_url ?? null}
              rosterSize={sc.roster_size}
              slotsLeft={Math.max(0, sc.roster_size - assignedCount)}
              entries={data.entries}
              onClose={() => setAddingTo(null)}
              onSubmit={(ids) => {
                setAddingTo(null);
                assignPlayers(addingTo, ids);
              }}
            />
          );
        })()}

      {confirm && (
        <Modal>
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm"
          >
            <div
              className="absolute inset-0 bg-space-950/70 backdrop-blur-sm"
              onClick={() => !busy && setConfirm(null)}
              aria-hidden="true"
            />
            <div className="relative bg-space-800 border border-astral-700/30 rounded-2xl p-6 w-full max-w-md shadow-2xl shadow-space-950">
              {confirm.kind === 'autofill' && (
                <>
                  <h3 className="font-display text-lg font-bold text-white">
                    Auto-fill {confirm.clan.clan_name ?? confirm.clan.clan_tag}?
                  </h3>
                  <p className="mt-2 text-sm text-astral-200/70">
                    These {confirm.players.length} unassigned player(s) with the highest war weight
                    will be added. Existing assignments stay.
                  </p>
                  <ul className="mt-3 max-h-56 overflow-y-auto rounded-xl border border-astral-700/30 divide-y divide-astral-700/20 text-sm">
                    {confirm.players.map((player, index) => (
                      <li key={player.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="w-5 text-astral-300/50">{index + 1}</span>
                        <span className="flex-1 truncate text-white">{player.player_name}</span>
                        <span className="tabular-nums text-astral-300/70">
                          {player.war_weight != null
                            ? player.war_weight.toLocaleString()
                            : 'no weight'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                  className="astral-btn-ghost justify-center"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={runConfirm}
                  className="astral-btn-primary justify-center disabled:opacity-50"
                >
                  {busy ? (
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  Auto-fill
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
