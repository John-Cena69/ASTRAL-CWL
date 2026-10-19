import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Star,
  Trash2,
  X,
  UserPlus,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import type { ClanRosterPlayer } from '@/types';

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

function formatDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().split('T')[0];
}

function valueColor(value: number): string {
  if (value <= 0) return 'text-amber-300';
  if (value < 1.5) return 'text-emerald-300';
  if (value < 2.5) return 'text-amber-400';
  return 'text-rose-300';
}

interface StrikeReason {
  id: string;
  value: number;
  reason_text: string;
  is_active: boolean;
  created_at: string | null;
}

interface ClanOverride {
  id: string;
  clan_tag: string;
  global_reason_id: string | null;
  is_enabled: boolean;
  custom_reason_text: string | null;
  custom_value: number | null;
  created_at: string | null;
}

interface ClanCustom {
  id: string;
  clan_tag: string;
  value: number;
  reason_text: string;
  is_active: boolean;
  created_at: string | null;
}

interface PendingStrike {
  id: string | null;
  player_tag: string;
  player_name: string;
  discord_id: string | null;
  value: number;
  reason: string;
  note: string;
  issued_date: string;
}

interface StrikeManagerPageProps {
  clanTag: string;
  clanName: string;
}

export default function StrikeManagerPage({ clanTag, clanName }: StrikeManagerPageProps) {
  const [roster, setRoster] = useState<ClanRosterPlayer[]>([]);
  const [globalReasons, setGlobalReasons] = useState<StrikeReason[]>([]);
  const [overrides, setOverrides] = useState<ClanOverride[]>([]);
  const [customReasons, setCustomReasons] = useState<ClanCustom[]>([]);
  const [pendingStrikes, setPendingStrikes] = useState<PendingStrike[]>([]);
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form state for adding a strike to batch
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlayer, setSelectedPlayer] = useState<ClanRosterPlayer | null>(null);
  const [strikeReason, setStrikeReason] = useState('');
  const [strikeValue, setStrikeValue] = useState('');
  const [strikeNote, setStrikeNote] = useState('');
  const [strikeDate, setStrikeDate] = useState('');
  const [isWarning, setIsWarning] = useState(false);
  const [showReasonDropdown, setShowReasonDropdown] = useState(false);

  const loadRoster = async () => {
    if (!supabase) return;
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`/api/clan-roster?clan_tag=${encodeURIComponent(clanTag)}`, {
        headers,
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        players?: ClanRosterPlayer[];
        error?: string;
      };
      if (body.ok && body.players) {
        setRoster(body.players);
      }
    } catch {
      // ignore
    }
  };

  const loadConfig = async () => {
    if (!supabase) return;
    setConfigLoading(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const vResp = await fetch(`/api/strike-config?type=global`, { headers });
      const vBody = (await vResp.json()) as { ok?: boolean; reasons?: StrikeReason[] };
      if (vBody.ok) {
        setGlobalReasons(vBody.reasons ?? []);
      }

      const cResp = await fetch(`/api/strike-config?type=clan&clan_tag=${encodeURIComponent(clanTag)}`, { headers });
      const cBody = (await cResp.json()) as { ok?: boolean; overrides?: ClanOverride[]; custom?: ClanCustom[] };
      if (cBody.ok) {
        setOverrides(cBody.overrides ?? []);
        setCustomReasons(cBody.custom ?? []);
      }
    } catch {
      // ignore
    } finally {
      setConfigLoading(false);
    }
  };

  const loadPending = async () => {
    if (!supabase) return;
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`/api/strikes?action=pending&clan_tag=${encodeURIComponent(clanTag)}`, {
        headers,
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        strikes?: any[];
        error?: string;
      };
      if (body.ok && body.strikes) {
        setPendingStrikes(
          body.strikes.map((s) => ({
            id: s.id,
            player_tag: s.player_tag,
            player_name: s.player_name,
            discord_id: s.discord_id,
            value: s.value,
            reason: s.reason,
            note: s.note ?? '',
            issued_date: s.issued_date,
          }))
        );
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void loadRoster();
    void loadConfig();
    void loadPending();
  }, [clanTag]);

  // Build available reasons for this clan: global reasons (respecting overrides) + custom
  const availableReasons = useMemo(() => {
    const reasonMap = new Map<string, { value: number; text: string; enabled: boolean; source: 'global' | 'custom' }>();

    // Add global reasons with overrides applied
    for (const reason of globalReasons) {
      const override = overrides.find((o) => o.global_reason_id === reason.id);
      const enabled = override ? override.is_enabled : true;
      const text = override?.custom_reason_text ?? reason.reason_text;
      const val = override?.custom_value ?? reason.value;
      reasonMap.set(reason.id, { value: val, text, enabled, source: 'global' });
    }

    // Add custom clan reasons
    for (const c of customReasons) {
      if (c.is_active) {
        reasonMap.set(c.id, { value: c.value, text: c.reason_text, enabled: true, source: 'custom' });
      }
    }

    return Array.from(reasonMap.values()).filter((r) => r.enabled);
  }, [globalReasons, overrides, customReasons]);

  // Filtered roster based on search query
  const filteredRoster = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter(
      (p) =>
        p.player_name.toLowerCase().includes(q) ||
        p.player_tag.toLowerCase().includes(q) ||
        (p.discord_id && p.discord_id.toLowerCase().includes(q))
    );
  }, [roster, searchQuery]);

  const handleSelectPlayer = (player: ClanRosterPlayer) => {
    setSelectedPlayer(player);
    setSearchQuery('');
  };

  const handleReasonSelect = (reasonText: string) => {
    const reason = availableReasons.find((r) => r.text === reasonText);
    if (reason) {
      setStrikeValue(reason.value.toString());
    }
    setStrikeReason(reasonText);
  };

  const handleAddToBatch = () => {
    if (!selectedPlayer) {
      setError('Select a player first.');
      return;
    }
    const val = parseFloat(strikeValue);
    if (!strikeValue.trim() || isNaN(val)) {
      setError('Enter a valid strike value.');
      return;
    }
    if (!strikeReason.trim()) {
      setError('Enter a strike reason.');
      return;
    }
    if (!strikeDate.trim()) {
      setError('Select an issued date.');
      return;
    }

    const finalValue = isWarning ? 0 : val;

    setPendingStrikes((prev) => [
      ...prev,
      {
        id: null,
        player_tag: selectedPlayer.player_tag,
        player_name: selectedPlayer.player_name,
        discord_id: selectedPlayer.discord_id ?? null,
        value: finalValue,
        reason: strikeReason.trim(),
        note: strikeNote.trim(),
        issued_date: strikeDate,
      },
    ]);

    setSelectedPlayer(null);
    setStrikeValue('');
    setStrikeReason('');
    setStrikeNote('');
    setStrikeDate('');
    setIsWarning(false);
    setError(null);
  };

  const removeFromBatch = (index: number) => {
    setPendingStrikes((prev) => prev.filter((_, i) => i !== index));
  };

  const handleConfirmBatch = async () => {
    if (!supabase) return;
    if (pendingStrikes.length === 0) {
      setError('No strikes to confirm.');
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch('/api/strikes?action=confirm_batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          clan_tag: clanTag,
          strikes: pendingStrikes.map((s) => ({
            player_tag: s.player_tag,
            player_name: s.player_name,
            discord_id: s.discord_id,
            value: s.value,
            reason: s.reason,
            note: s.note,
            issued_date: s.issued_date,
          })),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Failed to confirm strikes (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Failed to confirm strikes.');
      setNotice(`Confirmed ${pendingStrikes.length} strike(s).`);
      setPendingStrikes([]);
      await loadPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm strikes.');
    } finally {
      setConfirming(false);
    }
  };

  const handleSaveConfig = async (action: string, payload: Record<string, unknown>) => {
    if (!supabase) return;
    setIssuing(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await fetch('/api/strike-config?type=global', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session.session?.access_token ? { Authorization: `Bearer ${session.session.access_token}` } : {}),
        },
        body: JSON.stringify({ action, clan_tag: clanTag, ...payload }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Save failed (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Save failed.');
      setNotice('Strike config saved.');
      await loadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setIssuing(false);
    }
  };

  const totalPendingValue = pendingStrikes.reduce((sum, s) => sum + s.value, 0);

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">{clanName} — Strike Manager</h2>
            <p className="text-xs text-gold-400/80 font-mono">{clanTag}</p>
          </div>
          <p className="mt-1 text-sm text-astral-300/60">
            Issue strikes to clan players. Strikes go to pending first, then confirm in batch.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          <button
            onClick={() => {
              void loadRoster();
              void loadConfig();
              void loadPending();
            }}
            disabled={loading}
            className="astral-btn-ghost" title="Refresh">
            {loading ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {loading ? 'Loading...' : 'Refresh'}
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

      {/* === Issue Strike Batch Form === */}
      <section className="astral-card overflow-hidden">
        <div className="px-6 py-4 border-b border-astral-700/30">
          <h3 className="font-semibold text-astral-100">Issue Strike (Add to Batch)</h3>
          <p className="mt-1 text-sm text-astral-300/60">
            Select a player, set strike details, then add to batch. Confirm all at once below.
          </p>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex flex-col gap-2">
            <label className="text-xs text-astral-300/60 uppercase tracking-wide">Player</label>
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search player by name, tag, or Discord..."
                className="astral-input w-full text-sm"
              />
              {searchQuery.trim() && (
                <div className="absolute z-20 mt-1 w-full bg-space-800 border border-astral-700/30 rounded-xl shadow-xl max-h-48 overflow-y-auto">
                  {filteredRoster.map((p) => (
                    <div
                      key={p.player_tag}
                      onClick={() => handleSelectPlayer(p)}
                      className="px-4 py-2 text-sm cursor-pointer hover:bg-astral-700/30 flex items-center justify-between"
                    >
                      <div>
                        <div className="text-astral-100 font-medium">{p.player_name}</div>
                        <div className="text-xs text-astral-300/50">
                          {p.player_tag} {p.discord_id ? `| @${p.discord_id}` : ''}
                        </div>
                      </div>
                      <Check className="w-4 h-4 text-gold-400" />
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selectedPlayer && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-emerald-300">✓ Selected: {selectedPlayer.player_name}</span>
                <button
                  onClick={() => setSelectedPlayer(null)}
                  className="p-1 text-rose-300/70 hover:text-rose-200"
                  title="Clear selection"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs text-astral-300/60 uppercase tracking-wide">Reason</label>
            <div className="relative">
              <input
                type="text"
                value={strikeReason}
                onFocus={() => setShowReasonDropdown(true)}
                onChange={(e) => {
                  setShowReasonDropdown(true);
                  setStrikeReason(e.target.value);
                  // Auto-suggest matching reason
                  const typed = e.target.value.toLowerCase();
                  const match = availableReasons.find((r) => r.text.toLowerCase().includes(typed));
                  if (match && typed && match.text.toLowerCase().startsWith(typed)) {
                    setStrikeValue(match.value.toString());
                  }
                }}
                onBlur={() => setTimeout(() => setShowReasonDropdown(false), 150)}
                placeholder="Type or select a strike reason..."
                className="astral-input w-full text-sm"
              />
              {showReasonDropdown && availableReasons.length > 0 && (
                <div className="absolute z-20 mt-1 w-full bg-space-800 border border-astral-700/30 rounded-xl shadow-xl max-h-48 overflow-y-auto">
                  {availableReasons.map((r) => (
                    <div
                      key={`${r.source}-${r.text}`}
                      onClick={() => {
                        handleReasonSelect(r.text);
                        setShowReasonDropdown(false);
                      }}
                      className="px-4 py-2 text-sm cursor-pointer hover:bg-astral-700/30"
                    >
                      <div className="text-astral-200">{r.text}</div>
                      <div className={`text-xs font-mono ${valueColor(r.value)}`}>{r.value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-xs text-astral-300/60 uppercase tracking-wide">Value</label>
              <input
                type="number"
                step="0.5"
                value={strikeValue}
                onChange={(e) => setStrikeValue(e.target.value)}
                placeholder="0.5"
                className="astral-input w-full text-sm"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs text-astral-300/60 uppercase tracking-wide">Date</label>
              <input
                type="date"
                value={strikeDate}
                onChange={(e) => setStrikeDate(e.target.value)}
                className="astral-input w-full text-sm"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs text-astral-300/60 uppercase tracking-wide">Note</label>
            <input
              type="text"
              value={strikeNote}
              onChange={(e) => setStrikeNote(e.target.value)}
              placeholder="Optional note"
              className="astral-input w-full text-sm"
            />
          </div>

          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-xs text-astral-300/60 cursor-pointer">
              <input
                type="checkbox"
                checked={isWarning}
                onChange={() => setIsWarning(!isWarning)}
                className="h-4 w-4 accent-gold-400"
              />
              Warning (value = 0)
            </label>
          </div>

          <button
            onClick={handleAddToBatch}
            disabled={issuing || !selectedPlayer || !strikeValue.trim() || !strikeReason.trim() || !strikeDate.trim()}
            className="astral-btn-primary w-full sm:w-auto"
          >
            {issuing ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {issuing ? 'Adding...' : 'Add to Batch'}
          </button>
        </div>
      </section>

      {/* === Pending Batch === */}
      {pendingStrikes.length > 0 && (
        <section className="astral-card overflow-hidden">
          <div className="px-6 py-4 border-b border-astral-700/30">
            <h3 className="font-semibold text-astral-100">Pending Strikes ({pendingStrikes.length})</h3>
            <p className="mt-1 text-sm text-astral-300/60">
              Total value: <span className={`font-bold ${valueColor(totalPendingValue)}`}>{totalPendingValue}</span>
            </p>
          </div>
          <div className="p-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-space-700/40">
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Player</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Value</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Reason</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Note</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Date</th>
                  <th className="px-4 py-3 text-right text-astral-300/60 font-medium w-10">Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingStrikes.map((s, idx) => (
                  <tr
                    key={`${s.player_tag}-${idx}`}
                    className="border-t border-astral-700/15 hover:bg-astral-700/10"
                  >
                    <td className="px-4 py-3">
                      <div className="text-astral-100 font-medium">{s.player_name}</div>
                      <div className="text-xs text-astral-300/50 font-mono">{s.player_tag}</div>
                      {s.discord_id && (
                        <div className="text-xs text-astral-300/40">{s.discord_id}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-astral-100 font-medium">
                      <span className={`font-mono ${valueColor(s.value)}`}>{s.value}</span>
                    </td>
                    <td className="px-4 py-3 text-astral-200">{s.reason}</td>
                    <td className="px-4 py-3 text-astral-300/60">{s.note || '—'}</td>
                    <td className="px-4 py-3 text-astral-100 font-mono text-xs">{formatDate(s.issued_date)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => removeFromBatch(idx)}
                        className="p-1.5 text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/10 rounded"
                        title="Remove from batch"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-4 border-t border-astral-700/30 flex justify-end gap-2">
            <button
              onClick={() => setPendingStrikes([])}
              className="astral-btn-ghost" title="Clear all">
              <Trash2 className="w-4 h-4" /> Clear All
            </button>
            <button
              onClick={handleConfirmBatch}
              disabled={confirming}
              className="astral-btn-primary"
            >
              {confirming ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {confirming ? 'Confirming...' : 'Confirm Batch'}
            </button>
          </div>
        </section>
      )}

      {/* === Strike Config (Per-Clan Overrides + Custom) === */}
      <section className="astral-card overflow-hidden">
        <div className="px-6 py-4 border-b border-astral-700/30 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-astral-100">Per-Clan Strike Config</h3>
            <p className="mt-1 text-sm text-astral-300/60">
              Override global reasons or add clan-specific custom reasons.
            </p>
          </div>
        </div>
        <div className="p-6 space-y-6">
          <div className="space-y-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-astral-300/60">Global Reason Overrides</h4>
            {configLoading ? (
              <div className="astral-card p-4 text-center text-astral-300/60">
                <LoaderCircle className="w-5 h-5 animate-spin mx-auto" />
              </div>
            ) : globalReasons.length === 0 ? (
              <p className="text-xs text-astral-300/50">No global reasons configured.</p>
            ) : (
              <div className="space-y-3">
                {globalReasons.map((reason) => {
                  const override = overrides.find((o) => o.global_reason_id === reason.id);
                  const isEnabled = override ? override.is_enabled : true;
                  const customText = override?.custom_reason_text ?? '';
                  const customVal = override?.custom_value != null ? String(override.custom_value) : '';
                  return (
                    <div key={reason.id} className="p-3 bg-space-900/40 rounded-xl border border-astral-700/30">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <span className="text-astral-200 font-medium">{reason.reason_text}</span>
                        <span className={`text-xs font-mono ${valueColor(reason.value)}`}>{reason.value}</span>
                      </div>
                      <div className="grid sm:grid-cols-3 gap-3">
                        <label className="flex items-center gap-2 text-xs text-astral-300/60 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isEnabled}
                            onChange={() => void handleSaveConfig('clan_save_override', {
                              id: override?.id ?? '',
                              global_reason_id: reason.id,
                              is_enabled: !isEnabled,
                              custom_reason_text: customText || undefined,
                              custom_value: customVal ? parseFloat(customVal) : undefined,
                            })}
                            className="h-4 w-4 accent-gold-400"
                          />
                          Enabled
                        </label>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-astral-300/60 uppercase tracking-wide">Custom Text</label>
                          <input
                            type="text"
                            value={customText}
                            onChange={(e) => {
                              // stored locally, saved on checkbox toggle
                            }}
                            placeholder="Custom reason text"
                            className="astral-input w-full text-xs"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-astral-300/60 uppercase tracking-wide">Custom Value</label>
                          <input
                            type="number"
                            step="0.5"
                            value={customVal}
                            onChange={(e) => {
                              // stored locally, saved on checkbox toggle
                            }}
                            placeholder="0.5"
                            className="astral-input w-full text-xs"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-astral-300/60">Clan Custom Reasons</h4>
            {customReasons.length === 0 ? (
              <p className="text-xs text-astral-300/50">No custom reasons yet.</p>
            ) : (
              <div className="space-y-3">
                {customReasons.map((c) => (
                  <div key={c.id} className="p-3 bg-space-900/40 rounded-xl border border-astral-700/30 flex items-center justify-between">
                    <div>
                      <span className="text-astral-200 font-medium">{c.reason_text}</span>
                      <span className={`text-xs font-mono ${valueColor(c.value)} ml-2`}>{c.value}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleSaveConfig('clan_delete_custom', { id: c.id })}
                      className="p-1.5 text-rose-300/70 hover:text-rose-200"
                      title="Delete custom reason"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid sm:grid-cols-3 gap-3">
              <input
                type="text"
                value={strikeReason}
                onChange={(e) => setStrikeReason(e.target.value)}
                placeholder="New reason text"
                className="astral-input w-full text-sm"
              />
              <input
                type="number"
                step="0.5"
                value={strikeValue}
                onChange={(e) => setStrikeValue(e.target.value)}
                placeholder="Value"
                className="astral-input w-full text-sm"
              />
              <button
                onClick={() => void handleSaveConfig('clan_save_custom', {
                  id: '',
                  value: parseFloat(strikeValue) || 0,
                  reason_text: strikeReason.trim(),
                  is_active: true,
                })}
                disabled={issuing || !strikeReason.trim() || !strikeValue.trim()}
                className="astral-btn-primary"
              >
                {issuing ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
