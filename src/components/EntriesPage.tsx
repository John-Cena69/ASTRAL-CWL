import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, ChevronDown, ListChecks, LoaderCircle, Pencil, RefreshCw, Search, Shield, Trash2, X } from 'lucide-react';
import { supabase } from '@/supabaseClient';

interface CwlClanOption {
  clan_tag: string;
  clan_name: string | null;
  badge_url: string | null;
}

// Rendered on document.body so the page footer can never overlap a dialog.
function Modal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function EntriesPage() {
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
  const [clanFilter, setClanFilter] = useState('');

  const cwlClanOptions = [...new Set(entries.map((entry) => entry.cwl_clan_name).filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b));
  const query = search.trim().toLowerCase().replace(/^#/, '');
  const filtered = entries.filter((entry) => {
    if (clanFilter && entry.cwl_clan_name !== clanFilter) return false;
    if (!query) return true;
    return (
      entry.player_name.toLowerCase().includes(query) ||
      entry.player_tag.toLowerCase().replace(/^#/, '').includes(query) ||
      (entry.discord_id ?? '').includes(query)
    );
  });

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
      if (!editing.war_weight_from_clan_players) {
        payload.war_weight = weightInput.trim() === '' ? null : Number(weightInput);
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

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <ListChecks className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">CWL Entries</h2>
          </div>
          <p className="mt-1 text-sm text-astral-300/60">
            Players signed up for CWL ({filtered.length === entries.length ? entries.length : `${filtered.length} of ${entries.length}`}).
          </p>
        </div>
        <button onClick={() => void load()} disabled={loading} className="astral-btn-ghost" title="Reload entries">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-astral-300/50" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, tag or Discord ID..."
            className="astral-input w-full pl-9"
          />
        </div>
        <select value={clanFilter} onChange={(event) => setClanFilter(event.target.value)} className="astral-input sm:w-64" aria-label="Filter by CWL clan">
          <option value="">All CWL clans</option>
          {cwlClanOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>

      {(error || message) && (
        <div className={`p-4 rounded-xl border text-sm flex items-start gap-3 ${error ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'}`}>
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

      {loading ? (
        <div className="astral-card p-12 text-center text-astral-300/60">
          <LoaderCircle className="w-6 h-6 animate-spin mx-auto" />
          <p className="mt-3 text-sm">Loading entries...</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="astral-card p-12 text-center">
          <ListChecks className="w-8 h-8 mx-auto text-astral-300/40" />
          <p className="mt-3 text-astral-200">No CWL sign-ups yet.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="astral-card p-12 text-center">
          <Search className="w-8 h-8 mx-auto text-astral-300/40" />
          <p className="mt-3 text-astral-200">No entries match your filters.</p>
        </div>
      ) : (
        <div className="astral-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-astral-700/20 text-astral-300/60">
                <th className="px-4 py-3 text-left font-medium">#</th>
                <th className="px-4 py-3 text-left font-medium">Player Name</th>
                <th className="px-4 py-3 text-left font-medium">Player Tag</th>
                <th className="px-4 py-3 text-left font-medium">Discord ID</th>
                <th className="px-4 py-3 text-left font-medium">Home Clan</th>
                <th className="px-4 py-3 text-left font-medium">CWL Clan</th>
                <th className="px-4 py-3 text-right font-medium">War Weight</th>
                <th className="px-4 py-3 text-left font-medium">Notes</th>
                <th className="px-4 py-3 text-left font-medium">Signed up at</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry, index) => (
                <tr key={entry.id} className="border-b border-astral-700/10 text-astral-100">
                  <td className="px-4 py-3 text-astral-300/60">{index + 1}</td>
                  <td className="px-4 py-3 font-medium text-white">{entry.player_name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gold-300">{entry.player_tag}</td>
                  <td className="px-4 py-3 font-mono text-xs">{entry.discord_id || '—'}</td>
                  <td className="px-4 py-3">{entry.home_clan || '—'}</td>
                  <td className="px-4 py-3">{entry.cwl_clan_name || '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{entry.war_weight != null ? entry.war_weight.toLocaleString() : '—'}</td>
                  <td className="px-4 py-3 max-w-xs truncate" title={entry.notes ?? ''}>{entry.notes || '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-astral-300/70">{formatDate(entry.created_date)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEdit(entry)} className="p-2 text-astral-300/70 hover:text-white hover:bg-white/10 rounded-lg" title="Edit">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => { setPendingDelete(entry); setError(null); setMessage(null); }} className="p-2 text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/10 rounded-lg" title="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
                value={weightInput}
                onChange={(event) => setWeightInput(event.target.value)}
                disabled={editing.war_weight_from_clan_players}
                className="astral-input mt-1.5 w-full disabled:opacity-50"
              />
            </label>
            {editing.war_weight_from_clan_players && (
              <p className="mt-1 text-xs text-astral-300/50">Weight comes from the clan roster and is updated there.</p>
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
