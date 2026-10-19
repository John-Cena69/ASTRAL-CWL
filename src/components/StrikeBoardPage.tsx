import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Clock,
  CopyIcon,
  LoaderCircle,
  Edit2,
  Trash2,
  Shield,
  Star,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import type { ClanWarWeight } from '@/types';

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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
            <LoaderCircle className="w-4 h-4 animate-spin" /> Refresh
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
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-mono text-gold-400">{playerTag}</span>
                        {discordId && (
                          <>
                            <span className="text-astral-300/50">|</span>
                            <span className="text-astral-200 cursor-pointer hover:text-gold-300">
                              @{discordId}
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
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-space-700/40">
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium w-12">#</th>
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Value</th>
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Reason</th>
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Note</th>
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Issued Date</th>
                      <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Confirmed By</th>
                      <th className="px-4 py-3 text-right text-astral-300/60 font-medium w-14">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strikes.map((s, idx) => (
                      <tr
                        key={s.id}
                        className="border-t border-astral-700/15 hover:bg-astral-700/10 transition-colors group"
                      >
                        <td className="px-4 py-3 text-astral-300/40 font-mono text-xs">
                          {idx + 1}
                        </td>
                        <td className="px-4 py-3 text-astral-100 font-medium">
                          <span className={`font-mono ${valueColor(s.value ?? 0)}`}>
                            {s.value ?? 0}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-astral-200">
                          {s.reason || '—'}
                        </td>
                        <td className="px-4 py-3 text-astral-300/60">
                          {s.note || '—'}
                        </td>
                        <td className="px-4 py-3 text-astral-100 font-mono">
                          {formatDate(s.issued_date)}
                        </td>
                        <td className="px-4 py-3 text-astral-300/60 text-xs">
                          {s.confirmed_by || '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
