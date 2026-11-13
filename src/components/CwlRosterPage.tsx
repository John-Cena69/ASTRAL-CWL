import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Check,
  History,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Shield,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';

interface Season { id: string; name: string; created_by: string | null; created_at: string; closed_by: string | null; closed_at: string | null }
interface CwlClan { clan_tag: string; clan_name: string | null; cwl_league: string | null; badge_url: string | null }
interface SeasonClan { id: string; clan_tag: string; roster_size: number; added_by: string | null; added_at: string }
interface Entry {
  id: string;
  player_name: string;
  player_tag: string;
  discord_id: string | null;
  war_weight: number | null;
  notes: string | null;
  cwl_clan_tag: string | null;
  cwl_clan_name: string | null;
  cwl_assigned_at: string | null;
  created_date: string;
}
interface RosterData {
  season: Season | null;
  past_seasons: Season[];
  clans: CwlClan[];
  season_clans: SeasonClan[];
  entries: Entry[];
  warning: string | null;
}

function Modal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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

type Confirm =
  | { kind: 'remove_clan'; clan: CwlClan; count: number }
  | { kind: 'update_clans'; adds: string[]; removes: string[]; affected: number }
  | { kind: 'autofill'; clan: CwlClan; players: Entry[] }
  | { kind: 'new_season' }
  | { kind: 'close_season' }
  | { kind: 'rename_season' };

function PlayerPicker({ players, disabled, onPick }: { players: Entry[]; disabled: boolean; onPick: (entry: Entry) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const q = query.trim().toLowerCase().replace(/^#/, '');
  const results = players
    .filter((player) => !q || player.player_name.toLowerCase().includes(q) || player.player_tag.toLowerCase().replace(/^#/, '').includes(q))
    .sort(byWeightDesc);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="astral-btn-ghost disabled:opacity-40"
        title={disabled ? 'Roster is full' : 'Add a player'}
      >
        <UserPlus className="w-4 h-4" /> Add player
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 max-w-[85vw] rounded-xl border border-astral-700/40 bg-space-800 p-2 shadow-2xl shadow-space-950">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-astral-300/50" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name or tag..."
              className="astral-input w-full pl-9"
            />
          </div>
          <ul className="mt-2 max-h-64 overflow-y-auto">
            {results.length === 0 ? (
              <li className="px-3 py-4 text-center text-sm text-astral-300/50">No unassigned players found.</li>
            ) : results.map((player) => (
              <li key={player.id}>
                <button
                  type="button"
                  onClick={() => { onPick(player); setOpen(false); setQuery(''); }}
                  className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/5"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-sm font-medium text-white">{player.player_name}</span>
                    <span className="block font-mono text-xs text-gold-400/70">{player.player_tag}</span>
                  </span>
                  <span className="text-xs tabular-nums text-astral-300/70">{player.war_weight != null ? player.war_weight.toLocaleString() : 'no weight'}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function CwlRosterPage() {
  const [data, setData] = useState<RosterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [clearAssignments, setClearAssignments] = useState(true);

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
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const body = (await request('GET')) as unknown as RosterData;
      setData(body);
      if (body.warning) setMessage(body.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roster.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Runs a mutation, then reloads. Returns true on success.
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

  const clanByTag = useMemo(() => new Map((data?.clans ?? []).map((clan) => [clan.clan_tag, clan])), [data]);
  const seasonTags = useMemo(() => new Set((data?.season_clans ?? []).map((sc) => sc.clan_tag)), [data]);
  const unassigned = useMemo(() => (data?.entries ?? []).filter((entry) => !entry.cwl_clan_tag), [data]);

  // Draft clan selection: null means "same as what is saved".
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const effectiveDraft = draft ?? seasonTags;
  const draftAdds = (data?.clans ?? []).map((c) => c.clan_tag).filter((tag) => effectiveDraft.has(tag) && !seasonTags.has(tag));
  const draftRemoves = [...seasonTags].filter((tag) => !effectiveDraft.has(tag));
  const toggleDraft = (tag: string) => {
    setDraft((current) => {
      const next = new Set(current ?? seasonTags);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };
  const applyClanChanges = async () => {
    setError(null);
    setMessage(null);
    if (draftRemoves.length > 0) {
      const affected = (data?.entries ?? []).filter((entry) => entry.cwl_clan_tag && draftRemoves.includes(entry.cwl_clan_tag)).length;
      setConfirm({ kind: 'update_clans', adds: draftAdds, removes: draftRemoves, affected });
      return;
    }
    if (await act({ action: 'update_clans', add: draftAdds, remove: [] }, `${draftAdds.length} clan(s) added to the season.`)) setDraft(null);
  };

  const openSeasonDialog = (kind: 'new_season' | 'close_season' | 'rename_season') => {
    setNameInput(kind === 'rename_season' ? data?.season?.name ?? '' : '');
    setClearAssignments(true);
    setConfirm({ kind });
    setError(null);
    setMessage(null);
  };

  const runConfirm = async () => {
    if (!confirm) return;
    let ok = false;
    if (confirm.kind === 'update_clans') {
      ok = await act({ action: 'update_clans', add: confirm.adds, remove: confirm.removes }, 'Season clans updated.');
      if (ok) setDraft(null);
    } else if (confirm.kind === 'remove_clan') {
      ok = await act({ action: 'remove_clan', clan_tag: confirm.clan.clan_tag }, `${confirm.clan.clan_name ?? confirm.clan.clan_tag} removed from this season.`);
    } else if (confirm.kind === 'autofill') {
      ok = await act(
        { action: 'autofill', clan_tag: confirm.clan.clan_tag, entry_ids: confirm.players.map((player) => player.id) },
        `Assigned ${confirm.players.length} player(s) to ${confirm.clan.clan_name ?? confirm.clan.clan_tag}.`
      );
    } else if (confirm.kind === 'new_season') {
      ok = await act({ action: 'create_season', name: nameInput, clear_assignments: clearAssignments }, 'New season started.');
    } else if (confirm.kind === 'close_season') {
      ok = await act({ action: 'close_season', clear_assignments: clearAssignments }, 'Season closed.');
    } else {
      ok = await act({ action: 'rename_season', name: nameInput }, 'Season renamed.');
    }
    if (ok) {
      setConfirm(null);
      if (confirm.kind === 'new_season' || confirm.kind === 'close_season') setDraft(null);
    }
  };

  const season = data?.season ?? null;

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">CWL Roster</h2>
          </div>
          {season ? (
            <p className="mt-1 text-sm text-astral-300/60">
              <span className="font-semibold text-gold-300">{season.name}</span> · started by {season.created_by ?? 'unknown'} on {formatDate(season.created_at)}
            </p>
          ) : (
            <p className="mt-1 text-sm text-astral-300/60">No active season.</p>
          )}
        </div>
        {season && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => openSeasonDialog('rename_season')} className="astral-btn-ghost" title="Rename season"><Pencil className="w-4 h-4" /> Rename</button>
            <button onClick={() => openSeasonDialog('new_season')} className="astral-btn-ghost"><Plus className="w-4 h-4" /> New season</button>
            <button onClick={() => openSeasonDialog('close_season')} className="astral-btn-ghost text-rose-200"><X className="w-4 h-4" /> Close season</button>
          </div>
        )}
      </div>

      {(error || message) && (
        <div className={`p-4 rounded-xl border text-sm flex items-start gap-3 ${error ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'}`}>
          {error && <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />}
          <p className="flex-1">{error || message}</p>
          <button type="button" onClick={() => { setError(null); setMessage(null); }} className="p-1 rounded-lg opacity-60 hover:opacity-100 hover:bg-white/10 transition shrink-0" title="Dismiss" aria-label="Dismiss notification">
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
          <p className="mt-3 text-astral-200">No active CWL season.</p>
          <button onClick={() => openSeasonDialog('new_season')} className="astral-btn-primary mt-4"><Plus className="w-4 h-4" /> Start a season</button>
          {(data?.past_seasons.length ?? 0) > 0 && (
            <p className="mt-4 text-xs text-astral-300/50">Last season: {data?.past_seasons[0].name} (closed {formatDate(data?.past_seasons[0].closed_at ?? null)})</p>
          )}
        </div>
      ) : (
        <>
          <section className="astral-card p-5">
            <h3 className="font-semibold text-white">Clans for this season</h3>
            <p className="mt-1 text-sm text-astral-300/60">Tick the clans you want in {season.name}, then apply all changes at once.</p>
            {(data?.clans.length ?? 0) === 0 ? (
              <p className="mt-3 text-sm text-astral-300/50">No CWL clans yet. Add some on the Dashboard.</p>
            ) : (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {data?.clans.map((clan) => {
                    const selected = effectiveDraft.has(clan.clan_tag);
                    const saved = seasonTags.has(clan.clan_tag);
                    const sc = data.season_clans.find((item) => item.clan_tag === clan.clan_tag);
                    const state = selected && !saved ? 'adding' : !selected && saved ? 'removing' : null;
                    return (
                      <button
                        key={clan.clan_tag}
                        type="button"
                        disabled={busy}
                        onClick={() => toggleDraft(clan.clan_tag)}
                        className={`flex items-center gap-3 rounded-xl border p-3 text-left transition disabled:opacity-60 ${selected ? 'border-gold-400/50 bg-gold-500/10' : 'border-astral-700/30 hover:bg-white/5'}`}
                        title={sc ? `Added by ${sc.added_by ?? 'unknown'} on ${formatDate(sc.added_at)}` : 'Select for this season'}
                      >
                        <span className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${selected ? 'border-gold-400 bg-gold-400/20 text-gold-200' : 'border-astral-300/40'}`}>
                          {selected && <Check className="w-3.5 h-3.5" />}
                        </span>
                        {clan.badge_url ? <img src={clan.badge_url} alt="" className="w-10 h-10 object-contain shrink-0" /> : <Shield className="w-8 h-8 text-astral-300/50 shrink-0" />}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-white">{clan.clan_name ?? clan.clan_tag}</span>
                          <span className="block truncate text-xs text-astral-300/60">{clan.cwl_league ?? 'Unranked'}</span>
                        </span>
                        {state && (
                          <span className={`text-[10px] font-semibold uppercase rounded-full px-2 py-0.5 ${state === 'adding' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
                            {state === 'adding' ? 'Adding' : 'Removing'}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || draftAdds.length + draftRemoves.length === 0}
                    onClick={applyClanChanges}
                    className="astral-btn-primary disabled:opacity-50"
                  >
                    {busy ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Apply changes{draftAdds.length + draftRemoves.length > 0 ? ` (+${draftAdds.length} / −${draftRemoves.length})` : ''}
                  </button>
                  <button
                    type="button"
                    disabled={busy || draftAdds.length + draftRemoves.length === 0}
                    onClick={() => setDraft(null)}
                    className="astral-btn-ghost disabled:opacity-40"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDraft(new Set(data?.clans.map((clan) => clan.clan_tag)))}
                    className="text-xs text-astral-300/60 hover:text-white underline underline-offset-2 ml-1"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDraft(new Set())}
                    className="text-xs text-astral-300/60 hover:text-white underline underline-offset-2"
                  >
                    Select none
                  </button>
                </div>
              </>
            )}
          </section>

          {data?.season_clans.length === 0 && (
            <div className="astral-card p-8 text-center text-sm text-astral-300/60">Select at least one clan above to start building rosters.</div>
          )}

          {data?.season_clans.map((sc) => {
            const clan = clanByTag.get(sc.clan_tag);
            const roster = data.entries.filter((entry) => entry.cwl_clan_tag === sc.clan_tag).sort(byAssignment);
            const weighted = roster.filter((entry) => entry.war_weight !== null);
            const average = weighted.length > 0 ? Math.round(weighted.reduce((sum, entry) => sum + (entry.war_weight ?? 0), 0) / weighted.length) : null;
            const free = Math.max(0, sc.roster_size - roster.length);
            const full = roster.length >= sc.roster_size;
            const clanLabel = clan?.clan_name ?? sc.clan_tag;
            const fillers = [...unassigned].sort(byWeightDesc).slice(0, free);

            return (
              <section key={sc.id} className="astral-card overflow-hidden">
                <div className="p-5 flex flex-col lg:flex-row lg:items-center gap-4 border-b border-astral-700/20">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {clan?.badge_url ? <img src={clan.badge_url} alt="" className="w-12 h-12 object-contain shrink-0" /> : <Shield className="w-10 h-10 text-astral-300/50 shrink-0" />}
                    <div className="min-w-0">
                      <h3 className="font-display text-lg font-bold text-white truncate">{clanLabel}</h3>
                      <p className="text-xs text-astral-300/60 truncate">{clan?.cwl_league ?? 'Unranked'} · <span className="font-mono">{sc.clan_tag}</span></p>
                    </div>
                  </div>

                  <div className="flex items-center gap-6 text-sm">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-astral-300/60">Players</div>
                      <div className={`font-semibold tabular-nums ${roster.length > sc.roster_size ? 'text-rose-300' : 'text-white'}`}>{roster.length}/{sc.roster_size}</div>
                    </div>
                    <div title={weighted.length < roster.length ? `${roster.length - weighted.length} player(s) without a weight are not counted` : 'Average of assigned players'}>
                      <div className="text-xs uppercase tracking-wide text-astral-300/60">Avg weight</div>
                      <div className="font-semibold tabular-nums text-gold-300">{average !== null ? average.toLocaleString() : '—'}</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex rounded-xl border border-astral-700/40 p-0.5" role="group" aria-label="Roster size">
                      {[15, 30].map((size) => (
                        <button
                          key={size}
                          type="button"
                          disabled={busy || sc.roster_size === size}
                          onClick={() => void act({ action: 'set_size', clan_tag: sc.clan_tag, roster_size: size })}
                          className={`px-3 py-1.5 text-sm rounded-lg transition ${sc.roster_size === size ? 'bg-gold-500/20 text-gold-200 font-semibold' : 'text-astral-200 hover:bg-white/5'}`}
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      disabled={busy || fillers.length === 0}
                      onClick={() => clan && setConfirm({ kind: 'autofill', clan, players: fillers })}
                      className="astral-btn-ghost disabled:opacity-40"
                      title={full ? 'Roster is full' : unassigned.length === 0 ? 'No unassigned players' : 'Fill empty slots with the highest-weight unassigned players'}
                    >
                      <Sparkles className="w-4 h-4" /> Auto-fill
                    </button>
                    <PlayerPicker
                      players={unassigned}
                      disabled={busy || full}
                      onPick={(player) => void act({ action: 'assign', entry_id: player.id, clan_tag: sc.clan_tag })}
                    />
                  </div>
                </div>

                {roster.length === 0 ? (
                  <p className="p-8 text-center text-sm text-astral-300/50">No players assigned yet.</p>
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
                          <th className="px-4 py-3 text-left font-medium">Notes</th>
                          <th className="px-4 py-3" />
                        </tr>
                      </thead>
                      <tbody>
                        {roster.map((entry, index) => (
                          <tr key={entry.id} className="border-b border-astral-700/10 text-astral-100">
                            <td className="px-4 py-3 text-astral-300/60">{index + 1}</td>
                            <td className="px-4 py-3 font-medium text-white">{entry.player_name}</td>
                            <td className="px-4 py-3 font-mono text-xs text-gold-300">{entry.player_tag}</td>
                            <td className="px-4 py-3 font-mono text-xs">{entry.discord_id || '—'}</td>
                            <td className="px-4 py-3">{entry.cwl_clan_name || clanLabel}</td>
                            <td className="px-4 py-3 text-right tabular-nums">{entry.war_weight != null ? entry.war_weight.toLocaleString() : '—'}</td>
                            <td className="px-4 py-3 max-w-xs truncate" title={entry.notes ?? ''}>{entry.notes || '—'}</td>
                            <td className="px-4 py-3 text-right">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void act({ action: 'unassign', entry_id: entry.id })}
                                className="p-2 text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/10 rounded-lg"
                                title="Unassign from this clan (keeps the CWL entry)"
                                aria-label={`Unassign ${entry.player_name}`}
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}

          {(data?.past_seasons.length ?? 0) > 0 && (
            <section className="astral-card p-5">
              <h3 className="flex items-center gap-2 font-semibold text-white"><History className="w-4 h-4 text-astral-300/70" /> Past seasons</h3>
              <ul className="mt-3 space-y-1.5 text-sm text-astral-200">
                {data?.past_seasons.map((past) => (
                  <li key={past.id} className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium text-white">{past.name}</span>
                    <span className="text-astral-300/60">closed by {past.closed_by ?? 'unknown'} on {formatDate(past.closed_at)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {confirm && (
        <Modal>
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Confirm">
            <div className="absolute inset-0 bg-space-950/70 backdrop-blur-sm" onClick={() => !busy && setConfirm(null)} aria-hidden="true" />
            <div className="relative bg-space-800 border border-astral-700/30 rounded-2xl p-6 w-full max-w-md shadow-2xl shadow-space-950">
              {confirm.kind === 'update_clans' && (
                <>
                  <h3 className="font-display text-lg font-bold text-white">Apply clan changes?</h3>
                  <p className="mt-2 text-sm text-astral-200/70">
                    {confirm.adds.length > 0 && <>Adding <span className="font-semibold text-white">{confirm.adds.map((tag) => clanByTag.get(tag)?.clan_name ?? tag).join(', ')}</span>. </>}
                    Removing <span className="font-semibold text-white">{confirm.removes.map((tag) => clanByTag.get(tag)?.clan_name ?? tag).join(', ')}</span>
                    {confirm.affected > 0 ? `; ${confirm.affected} assigned player(s) will be unassigned (their CWL entries are kept).` : '.'}
                  </p>
                </>
              )}
              {confirm.kind === 'remove_clan' && (
                <>
                  <h3 className="font-display text-lg font-bold text-white">Remove clan from season?</h3>
                  <p className="mt-2 text-sm text-astral-200/70">
                    <span className="font-semibold text-white">{confirm.clan.clan_name ?? confirm.clan.clan_tag}</span> will be removed from this season.
                    {confirm.count > 0 ? ` Its ${confirm.count} assigned player(s) will be unassigned (their CWL entries are kept).` : ''}
                  </p>
                </>
              )}
              {confirm.kind === 'autofill' && (
                <>
                  <h3 className="font-display text-lg font-bold text-white">Auto-fill {confirm.clan.clan_name ?? confirm.clan.clan_tag}?</h3>
                  <p className="mt-2 text-sm text-astral-200/70">
                    These {confirm.players.length} unassigned player(s) with the highest war weight will be added. Existing assignments stay.
                  </p>
                  <ul className="mt-3 max-h-56 overflow-y-auto rounded-xl border border-astral-700/30 divide-y divide-astral-700/20 text-sm">
                    {confirm.players.map((player, index) => (
                      <li key={player.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="w-5 text-astral-300/50">{index + 1}</span>
                        <span className="flex-1 truncate text-white">{player.player_name}</span>
                        <span className="tabular-nums text-astral-300/70">{player.war_weight != null ? player.war_weight.toLocaleString() : 'no weight'}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {(confirm.kind === 'new_season' || confirm.kind === 'rename_season') && (
                <>
                  <h3 className="font-display text-lg font-bold text-white">{confirm.kind === 'new_season' ? 'Start a new season' : 'Rename season'}</h3>
                  {confirm.kind === 'new_season' && season && (
                    <p className="mt-2 text-sm text-astral-200/70">This closes <span className="font-semibold text-white">{season.name}</span> and starts a fresh season with no clans selected.</p>
                  )}
                  <label className="mt-4 block text-sm text-astral-200">Season name
                    <input
                      autoFocus
                      maxLength={60}
                      value={nameInput}
                      onChange={(event) => setNameInput(event.target.value)}
                      placeholder="e.g. November 2026"
                      className="astral-input mt-1.5 w-full"
                    />
                  </label>
                </>
              )}
              {confirm.kind === 'close_season' && (
                <>
                  <h3 className="font-display text-lg font-bold text-white">Close season?</h3>
                  <p className="mt-2 text-sm text-astral-200/70"><span className="font-semibold text-white">{season?.name}</span> will be closed. You can start a new season afterwards.</p>
                </>
              )}
              {(confirm.kind === 'new_season' || confirm.kind === 'close_season') && (
                <label className="mt-4 flex items-start gap-2.5 text-sm text-astral-200">
                  <input type="checkbox" checked={clearAssignments} onChange={(event) => setClearAssignments(event.target.checked)} className="mt-0.5" />
                  <span>Unassign all players from their CWL clans (CWL entries are kept)</span>
                </label>
              )}
              <div className="mt-5 grid grid-cols-2 gap-3">
                <button type="button" disabled={busy} onClick={() => setConfirm(null)} className="astral-btn-ghost justify-center">Cancel</button>
                <button
                  type="button"
                  disabled={busy || ((confirm.kind === 'new_season' || confirm.kind === 'rename_season') && !nameInput.trim())}
                  onClick={() => void runConfirm()}
                  className={confirm.kind === 'remove_clan' || confirm.kind === 'close_season'
                    ? 'inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-2.5 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/25 disabled:opacity-50'
                    : 'astral-btn-primary justify-center disabled:opacity-50'}
                >
                  {busy ? <LoaderCircle className="w-4 h-4 animate-spin" /> : confirm.kind === 'remove_clan' ? <Trash2 className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                  {confirm.kind === 'remove_clan' ? 'Remove' : confirm.kind === 'close_season' ? 'Close season' : confirm.kind === 'autofill' ? 'Auto-fill' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
