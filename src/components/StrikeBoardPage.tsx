import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  Clock,
  CopyIcon,
  LoaderCircle,
  Edit2,
  Shield,
  Star,
  X,
  Save,
  Trash2,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function valueColor(value: number): string {
  if (value <= 0) return 'text-amber-300';
  if (value < 1.5) return 'text-emerald-300';
  if (value < 2.5) return 'text-amber-400';
  return 'text-rose-300';
}

interface StrikeRow {
  id: string;
  clan_tag: string;
  player_tag: string;
  player_name: string;
  discord_id: string | null;
  value: number | null;
  reason: string | null;
  note: string | null;
  issued_date: string | null;
  confirmed_date: string | null;
  confirmed_by: string | null;
  edited_by: string | null;
  is_active: boolean | null;
  season: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface StrikeBoardPageProps {
  clanTag: string;
  clanName: string;
}

function CopyButton({ value }: { value: string }) {
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
        <CopyIcon className="w-3.5 h-3.5 text-emerald-400" />
      ) : (
        <CopyIcon className="w-3.5 h-3.5 text-astral-300/60 hover:text-gold-400" />
      )}
    </button>
  );
}

export default function StrikeBoardPage({ clanTag, clanName }: StrikeBoardPageProps) {
  const [strikes, setStrikes] = useState<StrikeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, { value: string; reason: string; note: string; issued_date: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reducing, setReducing] = useState(false);
  const [showMonthlyConfirm, setShowMonthlyConfirm] = useState(false);
  const [showClanGamesConfirm, setShowClanGamesConfirm] = useState(false);
  const [showClanGamesPicker, setShowClanGamesPicker] = useState(false);
  const [clanGamesSelectedPlayers, setClanGamesSelectedPlayers] = useState<Set<string>>(new Set());

  const loadStrikes = async () => {
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch(`/api/strikes?action=confirmed&clan_tag=${encodeURIComponent(clanTag)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        strikes?: StrikeRow[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Failed to load strikes (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Failed to load strikes.');
      setStrikes(body.strikes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load strikes.');
    } finally {
      setLoading(false);
    }
  };

  const resolveStrike = async (id: string) => {
    if (!supabase) return;
    setResolvingId(id);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const authUser = session?.session?.user;
      const profileMetadata = authUser?.user_metadata ?? {};
      const discordIdentity = authUser?.identities?.find((identity: any) => identity.provider === 'discord');
      const discordData = discordIdentity?.identity_data ?? {};
      const removeDiscriminator = (val: unknown) =>
        typeof val === 'string' ? val.replace(/#0$/, '') : '';
      const issuedBy = removeDiscriminator(
        profileMetadata.user_name || discordData.username || profileMetadata.name || 'Unknown'
      );
      const response = await fetch('/api/strikes/resolve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ id }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Resolve failed (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Resolve failed.');
      setNotice('Strike resolved.');
      await loadStrikes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed.');
    } finally {
      setResolvingId(null);
    }
  };

  const startEdit = (strike: StrikeRow) => {
    setEditValues((prev) => ({
      ...prev,
      [strike.id]: {
        value: String(strike.value ?? ''),
        reason: strike.reason ?? '',
        note: strike.note ?? '',
        issued_date: strike.issued_date ? new Date(strike.issued_date).toISOString().split('T')[0] : '',
      },
    }));
    setEditingId(strike.id);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({});
  };

  const updateEditValue = (id: string, field: 'value' | 'reason' | 'note' | 'issued_date', value: string) => {
    setEditValues((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }));
  };

  const saveEdit = async (id: string) => {
    if (!supabase) return;
    const values = editValues[id];
    if (!values) return;
    setResolvingId(id);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      const authUser = session?.session?.user;
      const profileMetadata = authUser?.user_metadata ?? {};
      const discordIdentity = authUser?.identities?.find((identity: any) => identity.provider === 'discord');
      const discordData = discordIdentity?.identity_data ?? {};
      const removeDiscriminator = (val: unknown) =>
        typeof val === 'string' ? val.replace(/#0$/, '') : '';
      const editedBy = removeDiscriminator(
        profileMetadata.user_name || discordData.username || profileMetadata.name || 'Unknown'
      );
      const response = await fetch('/api/strikes?action=edit_strike', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          id,
          value: parseFloat(values.value),
          reason: values.reason,
          note: values.note,
          issued_date: values.issued_date,
          edited_by: editedBy,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Edit failed (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Edit failed.');
      setNotice('Strike updated.');
      cancelEdit();
      await loadStrikes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Edit failed.');
    } finally {
      setResolvingId(null);
    }
  };

  const handleMonthlyReduction = async () => {
    if (!supabase || reducing) return;
    setShowMonthlyConfirm(true);
  };

  const executeMonthlyReduction = async () => {
    if (!supabase) return;
    setReducing(true);
    setError(null);
    setShowMonthlyConfirm(false);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      const authUser = session?.session?.user;
      const profileMetadata = authUser?.user_metadata ?? {};
      const discordIdentity = authUser?.identities?.find((identity: any) => identity.provider === 'discord');
      const discordData = discordIdentity?.identity_data ?? {};
      const removeDiscriminator = (val: unknown) =>
        typeof val === 'string' ? val.replace(/#0$/, '') : '';
      const issuedBy = removeDiscriminator(
        profileMetadata.user_name || discordData.username || profileMetadata.name || 'Unknown'
      );
      const response = await fetch('/api/strikes?action=reduce', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          clan_tag: clanTag,
          reason: 'Monthly Strike Reduction',
          issued_by: issuedBy,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        inserted?: number;
      };
      if (!response.ok) throw new Error(body.error || `Reduction failed (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Reduction failed.');
      setNotice(`Monthly reduction applied to ${body.inserted ?? 0} player(s).`);
      await loadStrikes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reduction failed.');
    } finally {
      setReducing(false);
    }
  };

  const handleClanGamesReduction = async () => {
    if (!supabase || reducing) return;
    setShowClanGamesPicker(true);
  };

  const executeClanGamesReduction = async () => {
    if (!supabase || reducing) return;
    const selected = Array.from(clanGamesSelectedPlayers);
    if (selected.length === 0) {
      setError('Select at least one player.');
      return;
    }
    setReducing(true);
    setError(null);
    setShowClanGamesConfirm(false);
    setShowClanGamesPicker(false);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      const authUser = session?.session?.user;
      const profileMetadata = authUser?.user_metadata ?? {};
      const discordIdentity = authUser?.identities?.find((identity: any) => identity.provider === 'discord');
      const discordData = discordIdentity?.identity_data ?? {};
      const removeDiscriminator = (val: unknown) =>
        typeof val === 'string' ? val.replace(/#0$/, '') : '';
      const issuedBy = removeDiscriminator(
        profileMetadata.user_name || discordData.username || profileMetadata.name || 'Unknown'
      );
      const response = await fetch('/api/strikes?action=reduce', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          clan_tag: clanTag,
          player_tags: selected,
          reason: 'Clan Games Reduction',
          issued_by: issuedBy,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        inserted?: number;
      };
      if (!response.ok) throw new Error(body.error || `Reduction failed (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Reduction failed.');
      setNotice(`Clan Games reduction applied to ${body.inserted ?? 0} player(s).`);
      await loadStrikes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reduction failed.');
    } finally {
      setReducing(false);
    }
  };

  useEffect(() => {
    void loadStrikes();
  }, [clanTag]);

  // Group strikes by player
  const playerMap = new Map<string, {
    playerName: string;
    playerTag: string;
    discordId: string | null;
    total: number;
    strikes: StrikeRow[];
  }>();

  for (const s of strikes) {
    const existing = playerMap.get(s.player_tag);
    if (existing) {
      existing.strikes.push(s);
      existing.total += s.value ?? 0;
      // Prefer non-empty player_name / discord_id when merging
      if (!existing.playerName && s.player_name && s.player_name.trim()) {
        existing.playerName = s.player_name;
      }
      if (!existing.discordId && s.discord_id) {
        existing.discordId = s.discord_id;
      }
    } else {
      playerMap.set(s.player_tag, {
        playerName: s.player_name,
        playerTag: s.player_tag,
        discordId: s.discord_id,
        total: s.value ?? 0,
        strikes: [s],
      });
    }
  }

  const playerEntries = Array.from(playerMap.values()).sort((a, b) => b.total - a.total);

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">{clanName} — Strike Board</h2>
            <p className="text-xs text-gold-400/80 font-mono">{clanTag}</p>
          </div>
          <p className="mt-1 text-sm text-astral-300/60">
            Active confirmed strikes per player, sorted by highest total strike value.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={() => void loadStrikes()}
            className="astral-btn-ghost" title="Refresh strike board">
            {loading ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button
            onClick={handleMonthlyReduction}
            disabled={reducing}
            className="astral-btn-ghost text-xs" title="Monthly Strike Reduction (-1 all)">
            {reducing ? <LoaderCircle className="w-3 h-3 animate-spin" /> : <Clock className="w-3 h-3" />}
            Monthly Reduction
          </button>
          <button
            onClick={handleClanGamesReduction}
            disabled={reducing}
            className="astral-btn-ghost text-xs" title="Clan Games Reduction">
            {reducing ? <LoaderCircle className="w-3 h-3 animate-spin" /> : <Clock className="w-3 h-3" />}
            Clan Games
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <p className="text-sm flex-1">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="p-1 rounded-lg opacity-60 hover:opacity-100 hover:bg-white/10 transition shrink-0"
            title="Dismiss"
            aria-label="Dismiss error"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {notice && !error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200">
          <Star className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <p className="text-sm flex-1">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
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
          <p className="mt-3 text-sm">Loading strikes...</p>
        </div>
      ) : playerEntries.length === 0 ? (
        <div className="astral-card p-12 text-center">
          <Shield className="w-8 h-8 mx-auto text-astral-300/40" />
          <p className="mt-3 text-astral-200">No active strikes yet.</p>
          <p className="mt-1 text-sm text-astral-300/50">Use Strike Manager to issue strikes.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {playerEntries.map(({ playerName, playerTag, discordId, total, strikes }) => (
            <article key={playerTag} className="astral-card overflow-hidden">
              <div className="px-6 py-4 border-b border-astral-700/30 bg-gradient-to-r from-space-700/50 to-space-800/30">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-astral-500 to-astral-700 flex items-center justify-center shadow-lg shadow-astral-900/50">
                      <Shield className="w-5 h-5 text-gold-300" />
                    </div>
                    <div>
                      <h3 className="font-display text-lg font-bold text-white">
                        {playerName}
                      </h3>
                      <div className="flex items-center gap-2 text-sm flex-col sm:flex-row">
                        <span className="font-mono text-gold-400">#{playerTag.replace(/^#/, '')}</span>
                        {discordId && (
                          <>
                            <span className="text-astral-300/50">|</span>
                            <span className="text-astral-200 cursor-pointer hover:text-gold-300">
                              {discordId}
                            </span>
                            {discordId && <CopyButton value={`<@${discordId}`} />}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className={`text-2xl font-bold ${valueColor(total)}`}>
                      {total}
                    </span>
                    <p className="text-xs text-astral-300/50">Total Strike(s)</p>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm table-fixed">
                  <thead>
                    <tr className="bg-space-700/40">
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium w-12">#</th>
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium w-16">Value</th>
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium w-64">Reason</th>
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium w-24">Note</th>
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium w-24">Issued Date</th>
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium w-20">Confirmed By</th>
                      <th className="px-4 py-3 text-right text-astral-300/60 font-medium w-12">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strikes.map((s, idx) => {
                      const isEditing = editingId === s.id;
                      const ev = editValues[s.id];
                      return (
                        <tr
                          key={s.id}
                          className="border-t border-astral-700/15 hover:bg-astral-700/10 transition-colors group"
                        >
                          {isEditing ? (
                            <>
                              <td className="px-4 py-3 text-astral-300/40 font-mono text-xs w-12">
                                {idx + 1}
                              </td>
                              <td className="px-4 py-3 w-16">
                                <input
                                  type="number"
                                  step="0.5"
                                  value={ev.value}
                                  onChange={(e) => updateEditValue(s.id, 'value', e.target.value)}
                                  className="astral-input w-full text-xs text-center"
                                />
                              </td>
                              <td className="px-4 py-3 w-64">
                                <input
                                  type="text"
                                  value={ev.reason}
                                  onChange={(e) => updateEditValue(s.id, 'reason', e.target.value)}
                                  className="astral-input w-full text-xs"
                                />
                              </td>
                              <td className="px-4 py-3 w-24">
                                <input
                                  type="text"
                                  value={ev.note}
                                  onChange={(e) => updateEditValue(s.id, 'note', e.target.value)}
                                  className="astral-input w-full text-xs"
                                />
                              </td>
                              <td className="px-4 py-3 w-24">
                                <input
                                  type="date"
                                  value={ev.issued_date}
                                  onChange={(e) => updateEditValue(s.id, 'issued_date', e.target.value)}
                                  className="astral-input w-full text-xs"
                                />
                              </td>
                              <td className="px-4 py-3 text-astral-300/60 text-xs w-20">
                                {s.confirmed_by || '—'}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <button
                                  type="button"
                                  onClick={() => void saveEdit(s.id)}
                                  disabled={resolvingId === s.id}
                                  className="p-2 text-emerald-300/70 hover:text-emerald-200 hover:bg-emerald-500/10 rounded-lg transition"
                                  title="Save"
                                >
                                  {resolvingId === s.id ? (
                                    <LoaderCircle className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Save className="w-4 h-4" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEdit}
                                  className="p-2 text-astral-300/70 hover:text-white hover:bg-astral-700/10 rounded-lg"
                                  title="Cancel"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="px-4 py-3 text-astral-300/40 font-mono text-xs w-12">
                                {idx + 1}
                              </td>
                              <td className="px-4 py-3 text-astral-100 font-medium w-16">
                                <span className={`font-mono ${valueColor(s.value ?? 0)}`}>
                                  {s.value ?? 0}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-astral-200 w-64">
                                {s.reason || '—'}
                              </td>
                              <td className="px-4 py-3 text-astral-300/60 w-24 truncate">
                                {s.note || '—'}
                              </td>
                              <td className="px-4 py-3 text-astral-100 font-mono w-24">
                                {formatDate(s.issued_date)}
                              </td>
                              <td className="px-4 py-3 text-astral-300/60 text-xs w-20 truncate">
                                {s.confirmed_by || '—'}
                                {s.edited_by && (
                                  <div className="text-[10px] text-astral-400/60 mt-0.5 truncate">
                                    edited by: {s.edited_by}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right w-12">
                                <button
                                  type="button"
                                  onClick={() => void startEdit(s)}
                                  disabled={resolvingId === s.id}
                                  className="p-2 text-gold-300/70 hover:text-gold-200 hover:bg-gold-500/10 rounded-lg transition"
                                  title="Edit strike"
                                >
                                  <Edit2 className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void resolveStrike(s.id)}
                                  disabled={resolvingId === s.id}
                                  className="p-2 text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/10 rounded-lg transition"
                                  title={`Resolve strike ${s.id.slice(0, 8)}`}
                                >
                                  {resolvingId === s.id ? (
                                    <LoaderCircle className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-4 h-4" />
                                  )}
                                </button>
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* === Monthly Reduction Confirmation Modal === */}
      {showMonthlyConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Confirm monthly reduction">
          <div
            className="absolute inset-0 bg-space-950/70 backdrop-blur-sm"
            onClick={() => setShowMonthlyConfirm(false)}
            aria-hidden="true"
          />
          <div className="relative bg-space-800 border border-astral-700/30 rounded-2xl p-6 w-full max-w-sm text-center shadow-2xl shadow-space-950">
            <div className="mx-auto w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
              <Clock className="w-6 h-6 text-amber-300" />
            </div>
            <h3 className="mt-4 font-display text-lg font-bold text-white">Monthly Strike Reduction</h3>
            <p className="mt-2 text-sm text-astral-200/70">
              This will add -1 strike to every player with active strikes (capped at 0). This cannot be undone.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setShowMonthlyConfirm(false)}
                className="astral-btn-ghost justify-center"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeMonthlyReduction}
                disabled={reducing}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/25"
              >
                {reducing ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === Clan Games Player Picker Modal === */}
      {showClanGamesPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Select players for Clan Games reduction">
          <div
            className="absolute inset-0 bg-space-950/70 backdrop-blur-sm"
            onClick={() => setShowClanGamesPicker(false)}
            aria-hidden="true"
          />
          <div className="relative bg-space-800 border border-astral-700/30 rounded-2xl p-6 w-full max-w-md shadow-2xl shadow-space-950">
            <div className="mx-auto w-12 h-12 rounded-xl bg-gold-500/10 border border-gold-500/30 flex items-center justify-center">
              <Clock className="w-6 h-6 text-gold-300" />
            </div>
            <h3 className="mt-4 font-display text-lg font-bold text-white">Clan Games Reduction</h3>
            <p className="mt-2 text-sm text-astral-200/70">
              Select players who completed Clan Games. Each selected player gets -1 strike (capped at 0).
            </p>
            <div className="mt-4 max-h-60 overflow-y-auto space-y-1">
              {playerEntries.map(({ playerName, playerTag, discordId, total }) => {
                const isSelected = clanGamesSelectedPlayers.has(playerTag);
                return (
                  <div
                    key={playerTag}
                    onClick={() => {
                      if (isSelected) {
                        setClanGamesSelectedPlayers((prev) => {
                          const next = new Set(prev);
                          next.delete(playerTag);
                          return next;
                        });
                      } else {
                        setClanGamesSelectedPlayers((prev) => {
                          const next = new Set(prev);
                          next.add(playerTag);
                          return next;
                        });
                      }
                    }}
                    className={`flex items-center justify-between px-4 py-2.5 rounded-xl cursor-pointer hover:bg-astral-700/40 transition ${isSelected ? 'bg-gold-500/20 border border-gold-400/50' : 'border border-transparent'}`}
                  >
                    <div className="flex items-center gap-2 w-full min-w-0">
                      <div className="flex items-center gap-2">
                        {isSelected && <Check className="w-3.5 h-3.5 text-gold-400 flex-shrink-0" />}
                        <div className="flex-1 min-w-0">
                          <div className="text-astral-100 font-medium truncate">{playerName}</div>
                          <div className="text-xs text-astral-300/50 truncate">
                            {playerTag} {total !== 0 ? `· ${total} Strike(s)` : ''}
                          </div>
                        </div>
                      </div>
                      <span className={`text-xs font-mono ${valueColor(total)}`}>
                        {total}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-astral-300/50">
              Selected: {clanGamesSelectedPlayers.size} player(s)
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setShowClanGamesPicker(false)}
                className="astral-btn-ghost justify-center"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setShowClanGamesConfirm(true)}
                disabled={clanGamesSelectedPlayers.size === 0}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-gold-500/40 bg-gold-500/15 px-4 py-2.5 text-sm font-semibold text-gold-200 transition hover:bg-gold-500/25"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === Clan Games Reduction Confirmation Modal === */}
      {showClanGamesConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Confirm clan games reduction">
          <div
            className="absolute inset-0 bg-space-950/70 backdrop-blur-sm"
            onClick={() => setShowClanGamesConfirm(false)}
            aria-hidden="true"
          />
          <div className="relative bg-space-800 border border-astral-700/30 rounded-2xl p-6 w-full max-w-sm text-center shadow-2xl shadow-space-950">
            <div className="mx-auto w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
              <Clock className="w-6 h-6 text-amber-300" />
            </div>
            <h3 className="mt-4 font-display text-lg font-bold text-white">Confirm Clan Games Reduction</h3>
            <p className="mt-2 text-sm text-astral-200/70">
              This will add -1 strike (capped at 0) to {clanGamesSelectedPlayers.size} selected player(s). This cannot be undone.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setShowClanGamesConfirm(false)}
                className="astral-btn-ghost justify-center"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeClanGamesReduction}
                disabled={reducing}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/25"
              >
                {reducing ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

    </main>
  );
}
