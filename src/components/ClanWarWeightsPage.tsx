import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  Clock3,
  CopyIcon,
  LoaderCircle,
  RefreshCw,
  Shield,
  Swords,
  Star,
  User,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import type { ClanWarWeight } from '@/types';

interface ClanWarWeightsPageProps {
  clanTag: string;
  clanName: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function ClanWarWeightsPage({ clanTag, clanName }: ClanWarWeightsPageProps) {
  const [weights, setWeights] = useState<ClanWarWeight[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadWeights = async () => {
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
      const response = await fetch(`/api/war-weights?clan_tag=${encodeURIComponent(clanTag)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        weights?: ClanWarWeight[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Failed to load war weights (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Failed to load war weights.');
      setWeights(body.weights ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load war weights.');
    } finally {
      setLoading(false);
    }
  };

  const syncWeights = async () => {
    if (!supabase || syncing) return;
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch('/api/sync-war-weights', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ clan_tag: clanTag }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        updated?: number;
        state?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Sync failed (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Sync failed.');
      setNotice(`Synced ${body.updated ?? 0} war weight(s) for ${clanName}.`);
      await loadWeights();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    void loadWeights();
  }, [clanTag]);

  const totalWeight = weights.reduce((sum, w) => sum + (w.war_weight ?? 0), 0);

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Swords className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">{clanName} — War Weights</h2>
            <p className="text-xs text-gold-400/80 font-mono">{clanTag}</p>
          </div>
          <p className="mt-1 text-sm text-astral-300/60">
            War roster sorted by map position. War weight = Town Hall × 5. Synced manually via the button below.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 self-start sm:self-auto">
          <button
            onClick={() => void loadWeights()}
            className="astral-btn-ghost" title="Refresh war weights">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <button
            onClick={() => void syncWeights()}
            disabled={syncing}
            className="astral-btn-ghost" title="Fetch current war from CoC API and sync war weights">
            {syncing ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {syncing ? 'Syncing...' : 'Sync War Weights'}
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
          <p className="mt-3 text-sm">Loading war weights...</p>
        </div>
      ) : weights.length === 0 ? (
        <div className="astral-card p-12 text-center">
          <Shield className="w-8 h-8 mx-auto text-astral-300/40" />
          <p className="mt-3 text-astral-200">No war weight data yet.</p>
          <p className="mt-1 text-sm text-astral-300/50">The clan must be in a war to sync weights. Click "Sync War Weights" when a war is active.</p>
        </div>
      ) : (
        <div className="astral-card overflow-hidden">
          <div className="px-6 py-4 border-b border-astral-700/30">
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <div className="flex items-center gap-2 text-astral-200">
                <Star className="w-4 h-4 text-gold-400" />
                <span className="font-bold text-white">Total War Weight:</span>
                <span className="ml-2 text-gold-400 font-mono">{totalWeight}</span>
              </div>
              <div className="flex items-center gap-2 text-astral-200">
                <User className="w-4 h-4 text-astral-400" />
                <span className="font-bold text-white">Members:</span>
                <span className="ml-2 text-astral-100">{weights.length}</span>
              </div>
              <div className="flex items-center gap-2 text-astral-200">
                <Clock3 className="w-4 h-4 text-astral-400" />
                <span className="text-astral-100">{formatDate(weights[0]?.updated_date ?? null)}</span>
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-space-700/40">
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium w-12">#</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Player Name</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Player Tag</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Town Hall</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">War Weight</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Map Position</th>
                </tr>
              </thead>
              <tbody>
                {weights.map((w, idx) => (
                  <tr
                    key={w.player_tag}
                    className="border-t border-astral-700/15 hover:bg-astral-700/10 transition-colors group"
                  >
                    <td className="px-4 py-3 text-astral-300/40 font-mono text-xs">{w.map_position ?? idx + 1}</td>
                    <td className="px-4 py-3 text-astral-100 font-medium">{w.player_name}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-astral-200">{w.player_tag}</span>
                        {w.player_tag && <CopyButton value={w.player_tag} />}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-astral-100">{w.town_hall ?? '—'}</td>
                    <td className="px-4 py-3 text-astral-100 font-mono text-gold-300">
                      {w.war_weight ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-astral-100 font-mono">{w.map_position ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-3 bg-space-900/40 border-t border-astral-700/20 text-xs text-astral-300/50">
            Showing {weights.length} member(s) · Total: {totalWeight}
          </div>
        </div>
      )}
    </main>
  );
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
