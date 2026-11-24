import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  ListChecks,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  UserCheck,
  UserMinus,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';

type SortKey = 'cwl_clan' | 'home_clan' | 'war_weight';
type SortDir = 'asc' | 'desc';
type StatusFilter = 'all' | 'assigned' | 'unassigned';
interface SortSpec { key: SortKey; dir: SortDir }

const SORT_LABELS: Record<SortKey, string> = { cwl_clan: 'CWL Clan', home_clan: 'Home Clan', war_weight: 'War Weight' };
const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = { cwl_clan: 'asc', home_clan: 'asc', war_weight: 'desc' };
const SORT_DIR_TEXT: Record<SortKey, Record<SortDir, string>> = {
  cwl_clan: { asc: 'A–Z', desc: 'Z–A' },
  home_clan: { asc: 'A–Z', desc: 'Z–A' },
  war_weight: { asc: 'Low–High', desc: 'High–Low' },
};

function sortValue(entry: CwlEntry, key: SortKey): string | number | null {
  if (key === 'war_weight') return entry.war_weight;
  const raw = key === 'cwl_clan' ? entry.cwl_clan_name : entry.home_clan;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

interface CwlClanOption {
  clan_tag: string;
  clan_name: string | null;
  badge_url: string | null;
}

// Rendered on document.body so the page footer can never overlap a dialog.
function Modal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

function CopyableValue({
  value,
  label,
  className = '',
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Fallback if clipboard API fails
    }
  };

  return (
    <span className="group/copy inline-flex items-center gap-1.5 max-w-full">
      <span className={`truncate ${className}`}>{value}</span>
      <button
        type="button"
        onClick={(e) => void handleCopy(e)}
        className={`inline-flex items-center justify-center w-6 h-6 rounded-md border transition-all duration-150 shrink-0 ${
          copied
            ? 'opacity-100 bg-emerald-500/20 border-emerald-500/40 text-emerald-300 scale-105'
            : 'opacity-0 group-hover/copy:opacity-100 focus:opacity-100 bg-space-700/80 border-astral-600/40 text-astral-200 hover:text-white hover:bg-astral-600/30 hover:border-gold-400/40'
        }`}
        title={copied ? `Copied ${label}!` : `Copy ${label}`}
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      </button>
    </span>
  );
}

function ClanSelect({ value, options, onChange }: { value: string; options: CwlClanOption[]; onChange: (tag: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.clan_tag === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const badge = (option?: CwlClanOption) =>
    option?.badge_url
      ? <img src={option.badge_url} alt="" className="w-6 h-6 object-contain shrink-0" />
      : <Shield className="w-5 h-5 text-astral-300/50 shrink-0" />;

  return (
    <div ref={ref} className="relative mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="astral-input w-full flex items-center gap-2.5 text-left"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {badge(selected)}
        <span className={`flex-1 truncate ${selected ? 'text-white' : 'text-astral-300/50'}`}>
          {selected ? (selected.clan_name ?? selected.clan_tag) : 'No CWL clan'}
        </span>
        <ChevronDown className={`w-4 h-4 text-astral-300/60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul role="listbox" className="absolute z-10 mt-2 w-full max-h-60 overflow-y-auto rounded-xl border border-astral-700/40 bg-space-800 p-1.5 shadow-2xl shadow-space-950">
          <li>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onClick={() => { onChange(''); setOpen(false); }}
              className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-astral-300/70 hover:bg-white/5"
            >
              <X className="w-5 h-5 shrink-0" /> <span className="flex-1 text-left">No CWL clan</span>
              {!value && <Check className="w-4 h-4 text-gold-300" />}
            </button>
          </li>
          {options.map((option) => (
            <li key={option.clan_tag}>
              <button
                type="button"
                role="option"
                aria-selected={option.clan_tag === value}
                onClick={() => { onChange(option.clan_tag); setOpen(false); }}
                className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-white/5 ${option.clan_tag === value ? 'bg-white/5 text-white' : 'text-astral-100'}`}
              >
                {badge(option)}
                <span className="flex-1 min-w-0 text-left">
                  <span className="block truncate font-medium">{option.clan_name ?? option.clan_tag}</span>
                  <span className="block font-mono text-xs text-gold-400/70">{option.clan_tag}</span>
                </span>
                {option.clan_tag === value && <Check className="w-4 h-4 text-gold-300" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CwlEntry {
  id: string;
  cwl_clan_tag: string | null;
  player_name: string;
  player_tag: string;
  discord_id: string | null;
  war_weight: number | null;
  war_weight_from_clan_players: boolean;
  war_weight_override: number | null;
  notes: string | null;
  home_clan: string | null;
  cwl_clan_name: string | null;
  created_date: string;
}

function formatDateParts(value: string): { date: string; time: string } | null {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  };
}

export default function EntriesPage({ canEdit = true }: { canEdit?: boolean }) {
  const [entries, setEntries] = useState<CwlEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<CwlEntry | null>(null);
  const [weightInput, setWeightInput] = useState('');
  const [notesInput, setNotesInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CwlEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [clanOptions, setClanOptions] = useState<CwlClanOption[]>([]);
  const [clanInput, setClanInput] = useState('');
  const [sortKeys, setSortKeys] = useState<SortSpec[]>([]);
  const [clanFilter, setClanFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    if (!supabase) return;
    void supabase
      .from('cwl_clans')
      .select('clan_tag, clan_name, badge_url')
      .then(({ data }) => {
        const rows = (data ?? []) as CwlClanOption[];
        setClanOptions(rows.sort((a, b) => (a.clan_name ?? '').localeCompare(b.clan_name ?? '')));
      });
  }, []);

  const clanBadgeByTag = useMemo(
    () => new Map(clanOptions.map((c) => [c.clan_tag, c.badge_url])),
    [clanOptions]
  );

  const totalSignups = entries.length;
  const assignedCount = useMemo(
    () => entries.filter((e) => !!(e.cwl_clan_tag || e.cwl_clan_name?.trim())).length,
    [entries]
  );
  const unassignedCount = totalSignups - assignedCount;
  const assignedPercent = totalSignups > 0 ? Math.round((assignedCount / totalSignups) * 100) : 0;

  const cwlClanOptions = [...new Set(entries.map((entry) => entry.cwl_clan_name).filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b));
  const query = search.trim().toLowerCase().replace(/^#/, '');
  const matched = entries.filter((entry) => {
    const isAssigned = !!(entry.cwl_clan_tag || entry.cwl_clan_name?.trim());
    if (statusFilter === 'assigned' && !isAssigned) return false;
    if (statusFilter === 'unassigned' && isAssigned) return false;
    if (clanFilter && entry.cwl_clan_name !== clanFilter) return false;
    if (!query) return true;
    return (
      entry.player_name.toLowerCase().includes(query) ||
      entry.player_tag.toLowerCase().replace(/^#/, '').includes(query) ||
      (entry.discord_id ?? '').includes(query) ||
      (entry.notes ?? '').toLowerCase().includes(query) ||
      (entry.home_clan ?? '').toLowerCase().includes(query)
    );
  });

  // sortKeys[0] is the primary key; earlier picks act as tie-breakers for later ones.
  const filtered = [...matched].sort((a, b) => {
    for (const { key, dir } of sortKeys) {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      // Empty values (unassigned / no weight) always go to the bottom, whatever the direction.
      if (av === null && bv === null) continue;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base', numeric: true });
      if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
    }
    return new Date(a.created_date).getTime() - new Date(b.created_date).getTime();
  });

  const toggleSort = (key: SortKey) => {
    setSortKeys((current) => {
      const existing = current.find((item) => item.key === key);
      if (!existing) return [{ key, dir: SORT_DEFAULT_DIR[key] }, ...current];
      if (current[0].key !== key) return [existing, ...current.filter((item) => item.key !== key)];
      return current.map((item) => (item.key === key ? { ...item, dir: item.dir === 'asc' ? 'desc' : 'asc' } : item));
    });
  };
  const removeSort = (key: SortKey) => setSortKeys((current) => current.filter((item) => item.key !== key));

  const call = async (method: 'GET' | 'PATCH' | 'DELETE', payload?: Record<string, unknown>) => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const response = await fetch('/api/cwl-entries', {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; warning?: string | null; entries?: CwlEntry[] };
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await call('GET');
      setEntries(body.entries ?? []);
      if (body.warning) setMessage(body.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load entries.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openEdit = (entry: CwlEntry) => {
    setEditing(entry);
    setWeightInput(entry.war_weight != null ? String(entry.war_weight) : '');
    setNotesInput(entry.notes ?? '');
    setClanInput(entry.cwl_clan_tag ?? '');
    setError(null);
    setMessage(null);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { id: editing.id, notes: notesInput, cwl_clan_tag: clanInput };
      const nextWeight = weightInput.trim() === '' ? null : Number(weightInput);
      if (nextWeight !== editing.war_weight) {
        payload.war_weight = nextWeight;
      }
      await call('PATCH', payload);
      setEditing(null);
      setMessage(`${editing.player_name} updated.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await call('DELETE', { id: pendingDelete.id });
      setEntries((current) => current.filter((entry) => entry.id !== pendingDelete.id));
      setMessage(`${pendingDelete.player_name} removed from CWL entries.`);
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  };

  const hasActiveFilters = Boolean(search.trim() || clanFilter || statusFilter !== 'all');

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gold-400/20 to-astral-500/20 border border-gold-400/30 flex items-center justify-center shadow-lg shadow-gold-500/5">
              <ListChecks className="w-5 h-5 text-gold-400" />
            </div>
            <div>
              <h2 className="font-display text-2xl font-bold text-white tracking-wide">CWL Entries</h2>
              <p className="text-sm text-astral-300/60">
                Manage player sign-ups, clan placements, war weights, and notes.
              </p>
            </div>
          </div>
        </div>
        <button onClick={() => void load()} disabled={loading} className="astral-btn-ghost self-start sm:self-auto" title="Reload entries">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Summary Stats Cards (Interactive Quick-Filters) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          type="button"
          onClick={() => setStatusFilter('all')}
          className={`astral-card p-4 text-left transition-all duration-200 relative overflow-hidden group ${
            statusFilter === 'all'
              ? 'border-gold-400/50 bg-gradient-to-br from-space-800/90 via-space-800/70 to-gold-500/10 ring-1 ring-gold-400/25 shadow-lg shadow-gold-500/5'
              : 'hover:border-astral-500/40 hover:bg-space-700/40'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="text-xs font-medium uppercase tracking-wider text-astral-300/70">Player Signups</span>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="font-display text-3xl font-bold text-white tabular-nums">
                  {loading ? '—' : totalSignups}
                </span>
                <span className="text-xs text-astral-300/50">total registered</span>
              </div>
            </div>
            <div className="w-11 h-11 rounded-xl bg-astral-500/15 border border-astral-400/25 flex items-center justify-center text-astral-300 group-hover:scale-105 transition-transform">
              <Users className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-astral-300/60">
            <span>{cwlClanOptions.length} active CWL clan{cwlClanOptions.length === 1 ? '' : 's'}</span>
            {statusFilter === 'all' && <span className="text-gold-300 font-medium">Showing all</span>}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter((cur) => (cur === 'assigned' ? 'all' : 'assigned'))}
          className={`astral-card p-4 text-left transition-all duration-200 relative overflow-hidden group ${
            statusFilter === 'assigned'
              ? 'border-emerald-400/50 bg-gradient-to-br from-space-800/90 via-space-800/70 to-emerald-500/10 ring-1 ring-emerald-400/25 shadow-lg shadow-emerald-500/5'
              : 'hover:border-emerald-500/30 hover:bg-space-700/40'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="text-xs font-medium uppercase tracking-wider text-emerald-300/80">Assigned Players</span>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="font-display text-3xl font-bold text-emerald-300 tabular-nums">
                  {loading ? '—' : assignedCount}
                </span>
                {!loading && totalSignups > 0 && (
                  <span className="text-xs font-medium text-emerald-400/70">({assignedPercent}%)</span>
                )}
              </div>
            </div>
            <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-400/25 flex items-center justify-center text-emerald-300 group-hover:scale-105 transition-transform">
              <UserCheck className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3">
            <div className="h-1.5 w-full rounded-full bg-space-900/80 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-all duration-500"
                style={{ width: `${loading ? 0 : assignedPercent}%` }}
              />
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter((cur) => (cur === 'unassigned' ? 'all' : 'unassigned'))}
          className={`astral-card p-4 text-left transition-all duration-200 relative overflow-hidden group ${
            statusFilter === 'unassigned'
              ? 'border-amber-400/50 bg-gradient-to-br from-space-800/90 via-space-800/70 to-amber-500/10 ring-1 ring-amber-400/25 shadow-lg shadow-amber-500/5'
              : 'hover:border-amber-500/30 hover:bg-space-700/40'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="text-xs font-medium uppercase tracking-wider text-amber-300/80">Unassigned Players</span>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="font-display text-3xl font-bold text-amber-300 tabular-nums">
                  {loading ? '—' : unassignedCount}
                </span>
                <span className="text-xs text-astral-300/50">awaiting placement</span>
              </div>
            </div>
            <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-400/25 flex items-center justify-center text-amber-300 group-hover:scale-105 transition-transform">
              <UserMinus className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-astral-300/60">
            <span>{statusFilter === 'unassigned' ? 'Filtered to unassigned' : 'Click to filter unassigned'}</span>
            {!loading && totalSignups > 0 && (
              <span className="text-amber-300/80 font-medium">{100 - assignedPercent}% remaining</span>
            )}
          </div>
        </button>
      </div>

      {/* Unified Controls & Table Container */}
      <section className="astral-card overflow-hidden shadow-2xl shadow-space-950/60">
        {/* Search, Filter & Sort Toolbar */}
        <div className="p-4 sm:p-5 border-b border-astral-700/25 bg-space-900/30 space-y-3.5">
          <div className="flex flex-col lg:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-astral-300/50 pointer-events-none" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by player name, #tag, Discord ID, home clan, or notes..."
                className="astral-input w-full pl-10 pr-9 py-2 text-sm"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-astral-300/60 hover:text-white rounded-md"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5">
              <select
                value={clanFilter}
                onChange={(event) => setClanFilter(event.target.value)}
                className="astral-input py-2 text-sm sm:w-56"
                aria-label="Filter by CWL clan"
              >
                <option value="">All CWL clans</option>
                {cwlClanOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>

              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setClanFilter('');
                    setStatusFilter('all');
                  }}
                  className="astral-btn-ghost py-2 px-3 text-xs shrink-0"
                  title="Reset all filters"
                >
                  <X className="w-3.5 h-3.5" /> Reset
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-astral-300/50 mr-1">Sort by</span>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => {
                const position = sortKeys.findIndex((item) => item.key === key);
                const spec = position >= 0 ? sortKeys[position] : null;
                return (
                  <span
                    key={key}
                    className={`inline-flex items-center rounded-lg border text-xs transition ${
                      spec
                        ? 'border-gold-400/50 bg-gold-500/15 text-gold-200 shadow-sm shadow-gold-500/5'
                        : 'border-astral-700/40 bg-space-800/50 text-astral-200 hover:bg-white/5 hover:border-astral-600/50'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(key)}
                      className="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1"
                      title={spec ? (position === 0 ? 'Click to reverse direction' : 'Click to make this the primary sort') : 'Click to sort'}
                    >
                      {spec && sortKeys.length > 1 && (
                        <span className="w-4 h-4 rounded-full bg-gold-400/25 text-[10px] font-bold flex items-center justify-center">
                          {position + 1}
                        </span>
                      )}
                      {SORT_LABELS[key]}
                      {spec && (spec.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                      {spec && <span className="text-[11px] opacity-75">{SORT_DIR_TEXT[key][spec.dir]}</span>}
                    </button>
                    {spec && (
                      <button
                        type="button"
                        onClick={() => removeSort(key)}
                        className="pr-2 pl-0.5 py-1 opacity-70 hover:opacity-100"
                        title={`Remove ${SORT_LABELS[key]} sort`}
                        aria-label={`Remove ${SORT_LABELS[key]} sort`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                );
              })}
              {sortKeys.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSortKeys([])}
                  className="text-xs text-astral-300/60 hover:text-white underline underline-offset-2 ml-1"
                >
                  Clear sort
                </button>
              )}
              {sortKeys.length > 1 && (
                <span className="text-[11px] text-astral-300/50 ml-1">
                  Priority: {sortKeys.map((item) => SORT_LABELS[item.key]).join(' → ')}
                </span>
              )}
            </div>

            <div className="text-xs text-astral-300/60">
              Showing <span className="font-semibold text-white">{filtered.length}</span> of{' '}
              <span className="font-semibold text-white">{entries.length}</span> entries
            </div>
          </div>
        </div>

        {(error || message) && (
          <div className={`mx-4 mt-4 p-3.5 rounded-xl border text-sm flex items-start gap-3 ${error ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'}`}>
            {error && <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />}
            <p className="flex-1">{error || message}</p>
            <button
              type="button"
              onClick={() => { setError(null); setMessage(null); }}
              className="p-1 rounded-lg opacity-60 hover:opacity-100 hover:bg-white/10 transition shrink-0"
              title="Dismiss"
              aria-label="Dismiss notification"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Table Content */}
        {loading ? (
          <div className="p-16 text-center text-astral-300/60">
            <LoaderCircle className="w-7 h-7 animate-spin mx-auto text-gold-400" />
            <p className="mt-3 text-sm">Loading CWL entries...</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="p-16 text-center">
            <ListChecks className="w-10 h-10 mx-auto text-astral-300/30" />
            <p className="mt-3 text-base font-medium text-astral-100">No CWL sign-ups yet</p>
            <p className="mt-1 text-xs text-astral-300/50">Players who sign up for CWL will appear here.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-16 text-center">
            <Search className="w-10 h-10 mx-auto text-astral-300/30" />
            <p className="mt-3 text-base font-medium text-astral-100">No entries match your filters</p>
            <p className="mt-1 text-xs text-astral-300/50">Try clearing your search query or switching filter tabs.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-astral-700/25 bg-space-900/50 text-[11px] font-semibold uppercase tracking-wider text-astral-300/60">
                  <th className="pl-4 pr-2 py-3.5 text-left w-10">#</th>
                  <th className="px-3 py-3.5 text-left min-w-[10.5rem]">Player</th>
                  <th className="px-3 py-3.5 text-left min-w-[11.5rem]">Discord ID</th>
                  <th className="px-3 py-3.5 text-left min-w-[8.5rem]">Home Clan</th>
                  <th className="px-3 py-3.5 text-left min-w-[10.5rem]">CWL Clan</th>
                  <th className="px-3 py-3.5 text-right whitespace-nowrap min-w-[7rem]">War Weight</th>
                  <th className="px-3 py-3.5 text-left min-w-[14rem] max-w-[24rem]">Notes</th>
                  <th className="px-3 py-3.5 text-left whitespace-nowrap">Signed Up</th>
                  <th className="pl-2 pr-4 py-3.5 text-right whitespace-nowrap w-24">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-astral-700/15">
                {filtered.map((entry, index) => {
                  const badgeUrl = entry.cwl_clan_tag ? clanBadgeByTag.get(entry.cwl_clan_tag) : null;
                  const dateParts = formatDateParts(entry.created_date);
                  const hasCwlClan = Boolean(entry.cwl_clan_name?.trim());
                  const hasHomeClan = Boolean(entry.home_clan?.trim());
                  const hasNotes = Boolean(entry.notes?.trim());

                  return (
                    <tr
                      key={entry.id}
                      className="group align-top transition-colors hover:bg-astral-600/[0.07]"
                    >
                      {/* # */}
                      <td className="pl-4 pr-2 py-3.5 text-xs font-mono text-astral-300/50 tabular-nums">
                        {index + 1}
                      </td>

                      {/* Player (Name + Copyable Tag) */}
                      <td className="px-3 py-3.5">
                        <div className="font-semibold text-white leading-snug break-words">
                          {entry.player_name}
                        </div>
                        <div className="mt-0.5">
                          <CopyableValue
                            value={entry.player_tag}
                            label="Player Tag"
                            className="font-mono text-xs text-gold-300/90"
                          />
                        </div>
                      </td>

                      {/* Discord ID */}
                      <td className="px-3 py-3.5">
                        {entry.discord_id ? (
                          <CopyableValue
                            value={entry.discord_id}
                            label="Discord ID"
                            className="font-mono text-xs text-astral-200"
                          />
                        ) : (
                          <span className="text-xs text-astral-300/35">—</span>
                        )}
                      </td>

                      {/* Home Clan */}
                      <td className="px-3 py-3.5">
                        {hasHomeClan ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-astral-100 bg-astral-500/10 border border-astral-500/20 px-2.5 py-1 rounded-lg leading-snug break-words">
                            {entry.home_clan}
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] text-astral-300/35 italic">
                            No home clan
                          </span>
                        )}
                      </td>

                      {/* CWL Clan */}
                      <td className="px-3 py-3.5">
                        {hasCwlClan ? (
                          <span className="inline-flex items-center gap-2 text-xs font-medium text-emerald-200 bg-emerald-500/10 border border-emerald-400/25 px-2.5 py-1 rounded-lg leading-snug">
                            {badgeUrl ? (
                              <img src={badgeUrl} alt="" className="w-4 h-4 object-contain shrink-0" />
                            ) : (
                              <Shield className="w-3.5 h-3.5 text-emerald-300/80 shrink-0" />
                            )}
                            <span className="break-words">{entry.cwl_clan_name}</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-300/80 bg-amber-500/10 border border-amber-400/20 px-2.5 py-1 rounded-lg">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80" />
                            Unassigned
                          </span>
                        )}
                      </td>

                      {/* War Weight */}
                      <td className="px-3 py-3.5 text-right whitespace-nowrap tabular-nums">
                        {entry.war_weight != null && entry.war_weight > 0 ? (
                          <span className="text-sm font-medium text-astral-100">
                            {entry.war_weight.toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-xs text-astral-300/35">—</span>
                        )}
                      </td>

                      {/* Notes (Full Multi-line Expansion!) */}
                      <td className="px-3 py-3.5 min-w-[14rem] max-w-[24rem]">
                        {hasNotes ? (
                          <div className="text-xs text-astral-100/90 leading-relaxed whitespace-pre-wrap break-words">
                            {entry.notes}
                          </div>
                        ) : (
                          <span className="text-xs text-astral-300/35">—</span>
                        )}
                      </td>

                      {/* Signed up at */}
                      <td className="px-3 py-3.5 whitespace-nowrap">
                        {dateParts ? (
                          <div className="leading-tight">
                            <div className="text-xs text-astral-200/85 font-medium">{dateParts.date}</div>
                            <div className="text-[11px] text-astral-300/50 mt-0.5">{dateParts.time}</div>
                          </div>
                        ) : (
                          <span className="text-[11px] text-astral-300/35 italic">Unknown</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="pl-2 pr-4 py-3.5 text-right whitespace-nowrap">
                        {canEdit && (
                          <div className="inline-flex items-center justify-end gap-1">
                            <button
                              onClick={() => openEdit(entry)}
                              className="p-2 text-astral-300/70 hover:text-gold-300 hover:bg-gold-500/10 border border-transparent hover:border-gold-400/25 rounded-lg transition"
                              title={`Edit ${entry.player_name}`}
                              aria-label={`Edit ${entry.player_name}`}
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => { setPendingDelete(entry); setError(null); setMessage(null); }}
                              className="p-2 text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/25 rounded-lg transition"
                              title={`Remove ${entry.player_name}`}
                              aria-label={`Remove ${entry.player_name}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <Modal>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Edit entry">
          <div className="absolute inset-0 bg-space-950/70 backdrop-blur-sm" onClick={() => setEditing(null)} aria-hidden="true" />
          <div className="relative bg-space-800 border border-astral-700/30 rounded-2xl p-6 w-full max-w-md shadow-2xl shadow-space-950">
            <h3 className="font-display text-lg font-bold text-white">Edit entry</h3>
            <p className="mt-1 text-sm text-astral-200/70">
              {editing.player_name} <span className="font-mono text-gold-300">({editing.player_tag})</span>
            </p>
            <label className="mt-4 block text-sm text-astral-200">War Weight
              <input
                type="number"
                min={0}
                step={1000}
                value={weightInput}
                onChange={(event) => setWeightInput(event.target.value)}
                className="astral-input mt-1.5 w-full"
              />
            </label>
            {editing.war_weight_from_clan_players && (
              <p className="mt-1 text-xs text-astral-300/50">Synced with the clan roster and war weights.</p>
            )}
            <div className="mt-4 text-sm text-astral-200">
              CWL Clan
              <ClanSelect value={clanInput} options={clanOptions} onChange={setClanInput} />
            </div>
            <label className="mt-4 block text-sm text-astral-200">Notes
              <textarea
                rows={3}
                value={notesInput}
                onChange={(event) => setNotesInput(event.target.value)}
                className="astral-input mt-1.5 w-full"
              />
            </label>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button type="button" onClick={() => setEditing(null)} className="astral-btn-ghost justify-center">Cancel</button>
              <button type="button" onClick={() => void handleSave()} disabled={saving} className="astral-btn-primary justify-center">
                {saving ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
              </button>
            </div>
          </div>
        </div>
        </Modal>
      )}

      {pendingDelete && (
        <Modal>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Confirm removal">
          <div className="absolute inset-0 bg-space-950/70 backdrop-blur-sm" onClick={() => setPendingDelete(null)} aria-hidden="true" />
          <div className="relative bg-space-800 border border-astral-700/30 rounded-2xl p-6 w-full max-w-sm text-center shadow-2xl shadow-space-950">
            <div className="mx-auto w-12 h-12 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center">
              <Trash2 className="w-6 h-6 text-rose-300" />
            </div>
            <h3 className="mt-4 font-display text-lg font-bold text-white">Remove entry?</h3>
            <p className="mt-2 text-sm text-astral-200/70">
              <span className="font-semibold text-white">{pendingDelete.player_name}</span>{' '}
              <span className="font-mono text-gold-300">({pendingDelete.player_tag})</span> will be removed from CWL entries. This cannot be undone.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button type="button" onClick={() => setPendingDelete(null)} className="astral-btn-ghost justify-center">Cancel</button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-2.5 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/25"
              >
                {deleting ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Remove
              </button>
            </div>
          </div>
        </div>
        </Modal>
      )}
    </main>
  );
}
