import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Clock3,
  CopyIcon,
  LoaderCircle,
  RefreshCw,
  Shield,
  Star,
  Swords,
  User,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import type { ClanRosterPlayer } from '@/types';

const ROLE_STYLES: Record<string, string> = {
  Leader: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  'Co-Leader': 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  Rep: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  Staff: 'bg-astral-500/15 text-astral-300 border-astral-500/30',
  Elder: 'bg-astral-500/15 text-astral-300 border-astral-500/30',
  Member: 'bg-astral-500/15 text-astral-300 border-astral-500/30',
  Filler: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
};

const STATUS_STYLES: Record<string, string> = {
  'All good': 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'Missing from Clan': 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  'Role Mismatch': 'bg-amber-500/15 text-amber-300 border-amber-500/30',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface ClanHomePageProps {
  clanTag: string;
  clanName: string;
}

export default function ClanHomePage({ clanTag, clanName }: ClanHomePageProps) {
  const [players, setPlayers] = useState<ClanRosterPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadRoster = async () => {
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
      const response = await fetch(`/api/clan-roster?clan_tag=${encodeURIComponent(clanTag)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        players?: ClanRosterPlayer[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Failed to load roster (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Failed to load roster.');
      setPlayers(body.players ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roster.');
    } finally {
      setLoading(false);
    }
  };

  const syncRoster = async () => {
    if (!supabase || syncing) return;
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch('/api/sync-clan-roster', {
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
        clan_name?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Sync failed (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Sync failed.');
      setNotice(`Synced ${body.updated ?? 0} player(s) for ${body.clan_name ?? clanName}.`);
      await loadRoster();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    void loadRoster();
  }, [clanTag]);

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">{clanName}</h2>
            <p className="text-xs text-gold-400/80 font-mono">{clanTag}</p>
          </div>
          <p className="mt-1 text-sm text-astral-300/60">
            Clan roster — synced manually via the button below. Data updates on click, not automatically.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 self-start sm:self-auto">
          <button
            onClick={() => void loadRoster()}
            className="astral-btn-ghost" title="Refresh roster">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <button
            onClick={() => void syncRoster()}
            disabled={syncing}
            className="astral-btn-ghost" title="Fetch latest roster from CoC API and sync to database">
            {syncing ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {syncing ? 'Syncing...' : 'Sync Roster'}
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
          <p className="mt-3 text-sm">Loading roster...</p>
        </div>
      ) : players.length === 0 ? (
        <div className="astral-card p-12 text-center">
          <Shield className="w-8 h-8 mx-auto text-astral-300/40" />
          <p className="mt-3 text-astral-200">No roster data yet.</p>
          <p className="mt-1 text-sm text-astral-300/50">Click "Sync Roster" to fetch members from the CoC API.</p>
        </div>
      ) : (
        <div className="astral-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-space-700/40">
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium w-12">#</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Player Name</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Player Tag</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Discord ID</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Town Hall</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Role</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Status</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Join Date</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Days in Clan</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">War Weight</th>
                </tr>
              </thead>
              <tbody>
                {players.map((player, idx) => (
                  <tr
                    key={player.player_tag}
                    className="border-t border-astral-700/15 hover:bg-astral-700/10 transition-colors group"
                  >
                    <td className="px-4 py-3 text-astral-300/40 font-mono text-xs">{idx + 1}</td>
                    <td className="px-4 py-3 text-astral-100 font-medium">{player.player_name}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-astral-200">{player.player_tag}</span>
                        {player.player_tag && <CopyButton value={player.player_tag} />}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-astral-200">{player.discord_id || '—'}</span>
                        {player.discord_id && <CopyButton value={`<@${player.discord_id}>`} />}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-astral-100">{player.town_hall ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${
                          ROLE_STYLES[player.role ?? ''] || 'bg-astral-500/15 text-astral-300 border-astral-500/30'
                        }`}
                      >
                        {player.role || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${
                          STATUS_STYLES[player.status ?? ''] || 'bg-astral-500/15 text-astral-300 border-astral-500/30'
                        }`}
                      >
                        {player.status || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-astral-100">{formatDate(player.join_date)}</td>
                    <td className="px-4 py-3 text-astral-100 font-mono">{player.days_in_clan ?? '—'}</td>
                    <td className="px-4 py-3 text-astral-100 font-mono text-gold-300">
                      {player.war_weight ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-3 bg-space-900/40 border-t border-astral-700/20 text-xs text-astral-300/50">
            Showing {players.length} member(s)
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

