import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  Clock3,
  Copy,
  LoaderCircle,
  RefreshCw,
  Shield,
  Star,
  Swords,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';

interface FamilyWar {
  id: string;
  clan_tag: string | null;
  clan_badge_url: string | null;
  opponent_name: string | null;
  opponent_tag: string | null;
  state: string | null;
  prep_start_time: number | null;
  end_time: number | null;
  stars: number | null;
  attacks_used: number | null;
  opponent_stars: number | null;
  opponent_attacks_used: number | null;
  our_points: number | null;
  opponent_points: number | null;
  sync_used: string | null;
  war_result: string | null;
}

interface FamilyClan {
  clan_tag: string;
  clan_name: string;
}

const stateStyles: Record<string, string> = {
  preparation: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  inWar: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  warEnded: 'border-slate-400/30 bg-slate-400/10 text-slate-200',
};

function formatDate(timestamp: number | null) {
  if (!timestamp) return 'Time not available';
  const milliseconds = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(milliseconds).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function displayValue(value: string | null) {
  if (!value) return 'Unknown';
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
}

function normalizeDetermination(result: string | null) {
  return result?.trim().toLowerCase().replace(/[^a-z]/g, '') ?? '';
}

function getResultStyle(result: string | null) {
  const normalizedResult = normalizeDetermination(result);
  if (normalizedResult.includes('win') || normalizedResult.includes('won') || normalizedResult.includes('victory')) return 'text-emerald-300';
  if (normalizedResult.includes('loss') || normalizedResult.includes('lose') || normalizedResult.includes('lost') || normalizedResult.includes('defeat')) return 'text-rose-300';
  return 'text-gold-300';
}

function Determination({ result }: { result: string | null }) {
  const normalizedResult = normalizeDetermination(result);
  const isWin = normalizedResult.includes('win') || normalizedResult.includes('won') || normalizedResult.includes('victory');
  const isLoss = normalizedResult.includes('loss') || normalizedResult.includes('lose') || normalizedResult.includes('lost') || normalizedResult.includes('defeat');
  const dotStyle = isWin
    ? 'bg-emerald-400 animate-pulse'
    : isLoss
      ? 'bg-rose-400 animate-pulse'
      : 'bg-gold-400';
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${getResultStyle(result)}`}>
      <span className={`h-2 w-2 rounded-full ${dotStyle}`} aria-hidden="true" />
      {displayValue(result)}
    </span>
  );
}

function CopyAction({ label, value, disabled = false }: { label: string; value: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      disabled={disabled}
      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-astral-700/30 px-3 py-2 text-xs font-medium text-astral-200 transition hover:border-gold-400/40 hover:text-gold-300 disabled:cursor-not-allowed disabled:opacity-40"
      title={disabled ? 'Required clan tag is unavailable' : `Copy ${label}`}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

const WIN_TEMPLATE = `Hello! 👋🏻 It’s a pleasure to be matched with you.
Based on points it’s "OUR WIN"💎

We won’t be visiting your bases, as we trust that everything is in order. However, if you happen to notice any issues with your bases, we’d appreciate it if you could let us know before battle day begins so we’re aware of them.
We’ll gladly do the same on our end by inspecting our bases and informing you in advance if we find any issues. Let us know, if you’d like to visit.

Thanks, and happy looting! 💎`;

const LOSE_TEMPLATE = `Hello! 👋🏻 It’s a pleasure to be matched with you.
Based on points it’s "YOUR WIN"💎

We won’t be visiting your bases, as we trust that everything is in order. However, if you happen to notice any issues with your bases, we’d appreciate it if you could let us know before battle day begins so we’re aware of them.
We’ll gladly do the same on our end by inspecting our bases and informing you in advance if we find any issues. Let us know, if you’d like to visit.

Thanks, and happy looting! 💎`;

function getGameTemplate(opponentName: string, isWin: boolean) {
  return isWin
    ? `💎Win War vs ${opponentName}✅
▪️1st Attack: 3 star your mirror.
▪️2nd Attack: 1 or 2 star any base anytime. If not, please wait for the "Last 12 hours of clean up time" to 3 star any base. ⚠️Ask for any doubts.`
    : `💎Win War vs ${opponentName}❌
▪️1st Attack: 2 star your mirror.
▪️2nd Attack: 1 star any base anytime. If not, please wait for the "Last 12 hours of clean up time" to 2 star any base. ⚠️Ask for any doubts.`;
}

function isWinResult(result: string | null) {
  const normalizedResult = normalizeDetermination(result);
  return normalizedResult.includes('win') || normalizedResult.includes('won') || normalizedResult.includes('victory');
}

function isLossResult(result: string | null) {
  const normalizedResult = normalizeDetermination(result);
  return normalizedResult.includes('loss') || normalizedResult.includes('lose') || normalizedResult.includes('lost') || normalizedResult.includes('defeat');
}

/** Same tiebreak as the backend: points decide, equal points fall back to tag order + sync state. */
function calculatePreviewResult(
  ourPoints: number | null,
  opponentPoints: number | null,
  ourTag: string | null,
  opponentTag: string | null,
  syncState: 'Low' | 'High'
): string | null {
  if (ourPoints === null || opponentPoints === null || !ourTag || !opponentTag) return null;
  if (ourPoints > opponentPoints) return 'Win';
  if (ourPoints < opponentPoints) return 'Loss';
  const t1 = ourTag.replace(/#/g, '');
  const t2 = opponentTag.replace(/#/g, '');
  if (syncState === 'Low') return t1 < t2 ? 'Win' : 'Loss';
  return t1 > t2 ? 'Win' : 'Loss';
}

function syncErrorHint(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Sync failed.';
  if (message.includes('Failed to fetch') || message.includes('Load failed')) {
    return `${message} (Sync needs the deployed site or "npx vercel dev" — plain "npm run dev" has no /api.)`;
  }
  return message;
}

export default function WarsPage() {
  const [wars, setWars] = useState<FamilyWar[]>([]);
  const [clans, setClans] = useState<Map<string, FamilyClan>>(new Map());
  const [syncState, setSyncState] = useState<'Low' | 'High'>('Low');
  const [syncSaving, setSyncSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadWars = async () => {
    if (!supabase) {
      setError('Supabase is not configured. Add the values from .env.local and restart the app.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const [{ data: warRows, error: warError }, { data: clanRows, error: clanError }, { data: settingRow, error: settingError }] = await Promise.all([
      supabase
        .from('family_wars')
        .select('id, clan_tag, clan_badge_url, opponent_name, opponent_tag, state, prep_start_time, end_time, stars, attacks_used, opponent_stars, opponent_attacks_used, our_points, opponent_points, sync_used, war_result')
        .order('prep_start_time', { ascending: false }),
      supabase.from('family_clans').select('clan_tag, clan_name'),
      supabase.from('bot_settings').select('setting_value').eq('setting_key', 'fwa_sync_state').maybeSingle(),
    ]);

    if (warError || clanError || settingError) {
      setError(warError?.message || clanError?.message || settingError?.message || 'Could not load wars.');
      setLoading(false);
      return;
    }

    setWars((warRows ?? []) as FamilyWar[]);
    setClans(new Map((clanRows ?? []).map((clan) => [clan.clan_tag, clan])));
    setSyncState(settingRow?.setting_value === 'High' ? 'High' : 'Low');
    setLoading(false);
  };

  const updateSyncState = async (nextState: 'Low' | 'High') => {
    if (!supabase || nextState === syncState) return;
    setSyncSaving(true);
    setError(null);
    setNotice(null);
    const { error: updateError } = await supabase
      .from('bot_settings')
      .update({ setting_value: nextState })
      .eq('setting_key', 'fwa_sync_state');
    if (updateError) setError(updateError.message);
    else {
      setSyncState(nextState);
      setNotice(`FWA sync saved as ${nextState} — determinations below update immediately.`);
    }
    setSyncSaving(false);
  };

  const syncNow = async () => {
    if (!supabase || syncing) return;
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch('/api/sync-wars', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        upserted?: number;
        checked?: number;
        skipped?: number;
        skipDetail?: string;
        errors?: string[];
      };
      if (!response.ok) throw new Error(body.error || `Sync failed (HTTP ${response.status}).`);
      const detail = `checked ${body.checked ?? '?'} clan(s), skipped ${body.skipped ?? '?'}${body.skipDetail ? ` (${body.skipDetail})` : ''}`;
      const errDetail = body.errors?.length ? ` Issues: ${body.errors.join(' | ').slice(0, 400)}` : '';
      if ((body.upserted ?? 0) === 0) {
        throw new Error(`Sync ran but updated nothing (${detail}).${errDetail}`);
      }
      setNotice(`Synced ${body.upserted ?? 0} war(s) from the CoC API.`);
      await loadWars();
    } catch (err) {
      setError(syncErrorHint(err));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    void loadWars();
    const refreshTimer = window.setInterval(() => void loadWars(), 60_000);
    return () => window.clearInterval(refreshTimer);
  }, []);

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Swords className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">Family Wars</h2>
          </div>
          <p className="mt-1 text-sm text-astral-300/60">Track every family matchup, score, and determination.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 self-start sm:self-auto">
          <div className="flex items-center gap-3 rounded-xl border border-astral-700/30 bg-space-800/70 px-3 py-2">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-astral-300/50">FWA sync</p>
              <p className={`text-sm font-semibold ${syncState === 'High' ? 'text-emerald-300' : 'text-rose-300'}`}>{syncState}</p>
            </div>
            <div className="flex rounded-lg border border-astral-700/40 bg-space-900/60 p-0.5" role="group" aria-label="FWA sync state">
              {(['Low', 'High'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => void updateSyncState(option)}
                  disabled={syncSaving}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${syncState === option ? option === 'High' ? 'bg-emerald-500/20 text-emerald-200' : 'bg-rose-500/20 text-rose-200' : 'text-astral-300/50 hover:text-astral-100'}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <button onClick={() => void loadWars()} className="astral-btn-ghost" title="Refresh wars">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <button onClick={() => void syncNow()} disabled={syncing} className="astral-btn-ghost" title="Fetch latest wars from the CoC API">
            {syncing ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {syncing ? 'Syncing...' : 'Sync now'}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {notice && !error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200">
          <Check className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <p className="text-sm">{notice}</p>
        </div>
      )}

      {loading ? (
        <div className="astral-card p-12 text-center text-astral-300/60">
          <LoaderCircle className="w-6 h-6 animate-spin mx-auto" />
          <p className="mt-3 text-sm">Loading wars...</p>
        </div>
      ) : wars.length === 0 ? (
        <div className="astral-card p-12 text-center">
          <Shield className="w-8 h-8 mx-auto text-astral-300/40" />
          <p className="mt-3 text-astral-200">No wars recorded yet.</p>
          <p className="mt-1 text-sm text-astral-300/50">Wars will appear here when the bot syncs them.</p>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {wars.map((war) => {
            const clan = war.clan_tag ? clans.get(war.clan_tag) : undefined;
            const stateKey = war.state ?? '';
            const result = calculatePreviewResult(war.our_points, war.opponent_points, war.clan_tag, war.opponent_tag, syncState) ?? war.war_result;
            const winTemplate = isWinResult(result);
            const hasTemplate = winTemplate || isLossResult(result);
            const warSync = war.sync_used === 'High' || war.sync_used === 'Low' ? war.sync_used : syncState;
            return (
              <article key={war.id} className="astral-card overflow-hidden">
                <div className="p-5 border-b border-astral-700/30">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {war.clan_badge_url ? (
                        <img src={war.clan_badge_url} alt="" className="w-12 h-12 object-contain" />
                      ) : (
                        <div className="w-12 h-12 rounded-xl bg-astral-700/30 flex items-center justify-center">
                          <Shield className="w-6 h-6 text-gold-300" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <h3 className="font-display text-lg font-bold text-white truncate">
                          {clan?.clan_name ?? war.clan_tag ?? 'Unknown clan'}
                        </h3>
                        <p className="text-xs text-astral-300/50 truncate">{war.clan_tag ?? 'No clan tag'}</p>
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${stateStyles[stateKey] ?? 'border-astral-400/30 bg-astral-400/10 text-astral-200'}`}>
                      {displayValue(war.state)}
                    </span>
                  </div>

                  <div className="mt-5 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs uppercase tracking-wide text-astral-300/50">Our clan</p>
                      <p className="mt-1 font-semibold text-white truncate">{clan?.clan_name ?? 'Family clan'}</p>
                    </div>
                    <span className="font-display text-sm text-gold-400">VS</span>
                    <div className="min-w-0 flex-1 text-right">
                      <p className="text-xs uppercase tracking-wide text-astral-300/50">Opponent</p>
                      {war.opponent_tag ? (
                        <a
                          href={`https://cc.fwafarm.com/cc_n/clan.php?tag=${encodeURIComponent(war.opponent_tag.replace(/^#+/, ''))}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 block truncate font-semibold text-white hover:text-gold-300 transition"
                        >
                          {war.opponent_name ?? 'Unknown opponent'}
                        </a>
                      ) : (
                        <p className="mt-1 font-semibold text-white truncate">{war.opponent_name ?? 'Unknown opponent'}</p>
                      )}
                      {war.opponent_tag && <p className="text-xs text-astral-300/50 truncate">{war.opponent_tag}</p>}
                    </div>
                  </div>
                </div>

                <div className="p-5">
                  <div className="grid grid-cols-3 divide-x divide-astral-700/30 border-y border-astral-700/30 py-3">
                    <div className="pr-3">
                      <p className="text-[11px] uppercase tracking-wide text-astral-300/50">Points</p>
                      <p className="mt-1 text-lg font-bold text-white">{war.our_points ?? '—'} <span className="text-astral-300/40">-</span> {war.opponent_points ?? '—'}</p>
                    </div>
                    <div className="px-3">
                      <p className="text-[11px] uppercase tracking-wide text-astral-300/50">Determination</p>
                      <div className="mt-1"><Determination result={result} /></div>
                    </div>
                    <div className="pl-3">
                      <p className="text-[11px] uppercase tracking-wide text-astral-300/50">Sync</p>
                      <p className={`mt-1 text-sm font-semibold ${warSync === 'High' ? 'text-emerald-300' : 'text-rose-300'}`} title={war.sync_used && war.sync_used !== syncState ? `Synced as ${war.sync_used}; global is now ${syncState}` : `Sync state used for this war: ${warSync}`}>{warSync}</p>
                    </div>
                  </div>

                  <div className="border-b border-astral-700/30 py-4">
                    <p className="text-[11px] uppercase tracking-wide text-astral-300/50">Schedule</p>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                      <div className="flex items-start gap-2 text-astral-200">
                        <Clock3 className="mt-0.5 w-4 h-4 text-astral-300/70" />
                        <span><span className="block text-xs text-astral-300/50">Starts</span>{formatDate(war.prep_start_time)}</span>
                      </div>
                      <div className="flex items-start gap-2 text-astral-200">
                        <Clock3 className="mt-0.5 w-4 h-4 text-astral-300/70" />
                        <span><span className="block text-xs text-astral-300/50">Ends</span>{formatDate(war.end_time)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-4">
                    <p className="text-[11px] uppercase tracking-wide text-astral-300/50">War stats</p>
                    <div className="mt-2 divide-y divide-astral-700/20 text-sm">
                      <div className="flex items-center justify-between gap-3 py-2 first:pt-0">
                        <span className="text-astral-200">Our clan</span>
                        <span className="flex items-center gap-4 text-astral-100">
                          <span className="inline-flex items-center gap-1.5"><Star className="w-4 h-4 fill-astral-400 text-astral-300" /> {war.stars ?? '—'} stars</span>
                          <span className="inline-flex items-center gap-1.5"><Swords className="w-4 h-4 text-astral-300" /> {war.attacks_used ?? '—'} attacks</span>
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3 py-2 last:pb-0">
                        <span className="text-astral-200">Opponent</span>
                        <span className="flex items-center gap-4 text-astral-100">
                          <span className="inline-flex items-center gap-1.5"><Star className="w-4 h-4 fill-astral-400 text-astral-300" /> {war.opponent_stars ?? '—'} stars</span>
                          <span className="inline-flex items-center gap-1.5"><Swords className="w-4 h-4 text-astral-300" /> {war.opponent_attacks_used ?? '—'} attacks</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 border-t border-astral-700/30 pt-4">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-astral-300/50">Band</p>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <CopyAction
                        label="Match Command"
                        value={`!match ${war.opponent_tag ?? ''}`}
                        disabled={!war.opponent_tag}
                      />
                      <CopyAction
                        label="Dual Rep matching"
                        value={`!match_spec ${war.clan_tag ?? ''} ${war.opponent_tag ?? ''}`}
                        disabled={!war.clan_tag || !war.opponent_tag}
                      />
                      {hasTemplate && (
                        <CopyAction
                          label={winTemplate ? 'Win Template' : 'Lose Template'}
                          value={winTemplate ? WIN_TEMPLATE : LOSE_TEMPLATE}
                        />
                      )}
                    </div>
                  </div>

                  {hasTemplate && (
                    <div className="mt-4 border-t border-astral-700/20 pt-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-astral-300/50">Game</p>
                      <div className="mt-2">
                        <CopyAction
                          label={winTemplate ? 'Win Game Template' : 'Lose Game Template'}
                          value={getGameTemplate(war.opponent_name ?? 'Opponent Clan', winTemplate)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
