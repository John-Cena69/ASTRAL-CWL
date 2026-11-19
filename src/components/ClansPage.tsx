import { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Check,
  ClipboardCheck,
  Copy,
  ExternalLink,
  Flag,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  Shield,
  Swords,
  Trash2,
  Trophy,
  User,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import { compareClansByLeague } from '@/cwlLeague';

interface CwlClan {
  clan_tag: string;
  clan_name: string | null;
  cwl_league: string | null;
  leader_name: string | null;
  badge_url: string | null;
}

function normalizeTagInput(value: string): string {
  return `#${value.trim().toUpperCase().replace(/^#+/, '')}`;
}

// League badge files in /public: bronze1-3, silver1-3, ..., titan1-3, legend.
// In-game, League III shows 1 bar and League I shows 3, so the file number is
// the pip count, not the numeral (e.g. "Gold League I" -> gold3.webp).
const LEAGUE_PIPS: Record<string, number> = { i: 3, ii: 2, iii: 1 };

function leagueBadgeSrc(league: string | null): string | null {
  if (!league || league.trim().toLowerCase().includes('unrank')) return '/unranked.webp';
  const lower = league.trim().toLowerCase();
  if (lower.includes('legend')) return '/legend.webp';
  const base = ['bronze', 'silver', 'gold', 'crystal', 'master', 'champion', 'titan'].find((b) =>
    lower.includes(b)
  );
  if (!base) return null;
  const numeral = lower.match(/\b(i{1,3})$/);
  if (!numeral) return null;
  const pips = LEAGUE_PIPS[numeral[1]];
  if (!pips) return null;
  return `/${base}${pips}.webp`;
}

function sortClans(clans: CwlClan[]): CwlClan[] {
  return [...clans].sort(compareClansByLeague);
}

type CwlSettingKey = 'cwl_signup_enabled' | 'cwl_roster_enabled' | 'cwl_tracker_enabled';

const CWL_TOGGLES: {
  key: CwlSettingKey;
  title: string;
  description: string;
  enabledText: string;
  disabledText: string;
  ariaLabel: string;
  icon: typeof Shield;
}[] = [
  {
    key: 'cwl_signup_enabled',
    title: 'Sign-ups',
    description: 'Allow players to register for CWL.',
    enabledText: 'Sign-ups are enabled',
    disabledText: 'Sign-ups are disabled',
    ariaLabel: 'Toggle CWL sign-ups',
    icon: ClipboardCheck,
  },
  {
    key: 'cwl_roster_enabled',
    title: 'Roster',
    description: 'Publish and sync assigned CWL clan rosters.',
    enabledText: 'Roster is enabled',
    disabledText: 'Roster is disabled',
    ariaLabel: 'Toggle CWL roster',
    icon: Users,
  },
  {
    key: 'cwl_tracker_enabled',
    title: 'Tracker',
    description: 'Track player movement and live clan status.',
    enabledText: 'Tracker is enabled',
    disabledText: 'Tracker is disabled',
    ariaLabel: 'Toggle CWL tracker',
    icon: Activity,
  },
];

export default function ClansPage() {
  const [clans, setClans] = useState<CwlClan[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cwlSettings, setCwlSettings] = useState<Record<CwlSettingKey, boolean | null>>({
    cwl_signup_enabled: null,
    cwl_roster_enabled: null,
    cwl_tracker_enabled: null,
  });
  const [savingSettings, setSavingSettings] = useState<Record<CwlSettingKey, boolean>>({
    cwl_signup_enabled: false,
    cwl_roster_enabled: false,
    cwl_tracker_enabled: false,
  });

  const loadClans = async () => {
    if (!supabase) {
      setError('Supabase is not configured. Add the values from .env.local and restart the app.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: loadError } = await supabase
      .from('cwl_clans')
      .select('clan_tag, clan_name, cwl_league, leader_name, badge_url');
    if (loadError) setError(loadError.message);
    else setClans(sortClans((data ?? []) as CwlClan[]));
    setLoading(false);
  };

  useEffect(() => {
    void loadClans();
    void loadSignup();
  }, []);

  const signupFetch = async (init: { method: 'GET' | 'POST'; body?: string }) => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const response = await fetch('/api/cwl-signup-settings', {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const body = (await response.json().catch(() => ({}))) as {
      enabled?: boolean;
      cwl_signup_enabled?: boolean;
      cwl_roster_enabled?: boolean;
      cwl_tracker_enabled?: boolean;
      error?: string;
    };
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };

  const loadSignup = async () => {
    try {
      const body = await signupFetch({ method: 'GET' });
      setCwlSettings({
        cwl_signup_enabled: Boolean(body.cwl_signup_enabled ?? body.enabled),
        cwl_roster_enabled: Boolean(body.cwl_roster_enabled),
        cwl_tracker_enabled: Boolean(body.cwl_tracker_enabled),
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load CWL settings.');
    }
  };

  const toggleSetting = async (key: CwlSettingKey) => {
    const current = cwlSettings[key];
    if (current === null || savingSettings[key]) return;
    const next = !current;
    setSavingSettings((prev) => ({ ...prev, [key]: true }));
    try {
      await signupFetch({ method: 'POST', body: JSON.stringify({ setting_name: key, enabled: next }) });
      setCwlSettings((prev) => ({ ...prev, [key]: next }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to update CWL setting.');
    } finally {
      setSavingSettings((prev) => ({ ...prev, [key]: false }));
    }
  };

  const authedFetch = async (method: 'POST' | 'DELETE', payload: Record<string, unknown>) => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const response = await fetch('/api/cwl-clans', {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(body.error || `Request failed (HTTP ${response.status}).`);
    return body;
  };

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    const tag = normalizeTagInput(tagInput);
    if (tag.length < 4) {
      setError('Enter a valid clan tag.');
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await authedFetch('POST', { clan_tag: tag });
      setTagInput('');
      setShowAdd(false);
      setMessage(`${tag} added — details fetched from the CoC API.`);
      await loadClans();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Add failed.';
      setError(
        message.includes('Failed to fetch') || message.includes('Load failed')
          ? `${message} (Adding needs the deployed site or "npx vercel dev" — plain "npm run dev" has no /api.)`
          : message
      );
    } finally {
      setSaving(false);
    }
  };

  const handleRefreshAll = async () => {
    if (!supabase || deletingTag) return;
    setDeletingTag('__refresh__');
    setError(null);
    setMessage(null);
    try {
      const body = (await authedFetch('POST', { refresh_all: true })) as {
        refreshed?: number;
        total?: number;
        errors?: string[];
      };
      const errDetail = body.errors?.length ? ` Issues: ${body.errors.join(' | ').slice(0, 300)}` : '';
      setMessage(`Refreshed ${body.refreshed ?? 0} of ${body.total ?? 0} clan(s) from the CoC API.${errDetail}`);
      await loadClans();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Refresh failed.';
      setError(
        message.includes('Failed to fetch') || message.includes('Load failed')
          ? `${message} (Refresh needs the deployed site or "npx vercel dev" — plain "npm run dev" has no /api.)`
          : message
      );
    } finally {
      setDeletingTag(null);
    }
  };
  const handleDelete = async (clanTag: string) => {
    setPendingDelete(null);
    setDeletingTag(clanTag);
    setError(null);
    setMessage(null);
    try {
      await authedFetch('DELETE', { clan_tag: clanTag });
      setClans((current) => current.filter((clan) => clan.clan_tag !== clanTag));
      setMessage(`${clanTag} removed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeletingTag(null);
    }
  };

  const [copiedTag, setCopiedTag] = useState<string | null>(null);

  const copyClanTag = async (tag: string) => {
    try {
      await navigator.clipboard.writeText(tag);
      setCopiedTag(tag);
      window.setTimeout(() => {
        setCopiedTag((current) => (current === tag ? null : current));
      }, 1500);
    } catch {
      // clipboard unavailable
    }
  };

  const activeSettingsCount = CWL_TOGGLES.filter((item) => cwlSettings[item.key] === true).length;
  const settingsLoaded = CWL_TOGGLES.every((item) => cwlSettings[item.key] !== null);

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-20 space-y-8">
      {/* ─── Page Header: CWL Dashboard ─── */}
      <header className="relative overflow-hidden rounded-2xl border border-astral-700/30 bg-gradient-to-br from-space-800/90 via-space-800/60 to-astral-950/40 p-6 sm:p-7 backdrop-blur-md shadow-xl shadow-space-950/50">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gold-400/5 blur-3xl" />
        <div className="pointer-events-none absolute -left-16 -bottom-16 h-48 w-48 rounded-full bg-astral-500/10 blur-3xl" />

        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start sm:items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-gold-400/20 to-astral-600/30 border border-gold-400/30 flex items-center justify-center shrink-0 shadow-lg shadow-astral-950/60">
              <Flag className="w-6 h-6 text-gold-300" />
            </div>
            <div>
              <h2 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
                CWL Dashboard
              </h2>
              <p className="mt-1 text-sm text-astral-200/70">
                Configure live CWL bot controls and manage our CWL clan lineup.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 self-start sm:self-center">
            <div className="inline-flex items-center gap-2 rounded-xl border border-astral-700/40 bg-space-900/60 px-3.5 py-2 text-xs font-medium text-astral-200">
              <span
                className={`h-2 w-2 rounded-full ${
                  !settingsLoaded
                    ? 'bg-astral-400 animate-pulse'
                    : activeSettingsCount > 0
                      ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                      : 'bg-astral-400/40'
                }`}
              />
              <span>
                {settingsLoaded ? `${activeSettingsCount}/3 modules active` : 'Syncing settings...'}
              </span>
            </div>
            <div className="inline-flex items-center gap-2 rounded-xl border border-gold-400/25 bg-gold-500/10 px-3.5 py-2 text-xs font-medium text-gold-200">
              <Shield className="w-3.5 h-3.5 text-gold-300" />
              <span>
                {loading ? 'Loading...' : `${clans.length} ${clans.length === 1 ? 'clan' : 'clans'}`}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ─── Notifications ─── */}
      {(error || message) && (
        <div
          className={`p-4 rounded-xl border text-sm flex items-start gap-3 shadow-lg ${
            error
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
          }`}
        >
          {error ? (
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-rose-300" />
          ) : (
            <Check className="w-5 h-5 flex-shrink-0 mt-0.5 text-emerald-300" />
          )}
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

      {/* ─── Section 1: CWL Settings ─── */}
      <section aria-labelledby="cwl-settings-heading" className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-astral-700/25 border border-astral-600/30 flex items-center justify-center text-gold-300">
              <Settings2 className="w-4 h-4" />
            </div>
            <div>
              <h3 id="cwl-settings-heading" className="font-display text-lg font-bold text-white">
                CWL Settings
              </h3>
              <p className="text-xs text-astral-300/60">
                Toggle CWL automation switches in real time.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {CWL_TOGGLES.map((item) => {
            const enabled = cwlSettings[item.key];
            const isSaving = savingSettings[item.key];
            const Icon = item.icon;
            const isOn = enabled === true;

            return (
              <div
                key={item.key}
                onClick={() => {
                  if (enabled !== null && !isSaving) void toggleSetting(item.key);
                }}
                className={`group relative overflow-hidden rounded-2xl border p-5 transition-all duration-200 ${
                  enabled === null || isSaving ? 'cursor-wait' : 'cursor-pointer'
                } ${
                  isOn
                    ? 'border-emerald-500/35 bg-gradient-to-br from-emerald-500/[0.09] via-space-800/80 to-space-800/80 shadow-lg shadow-emerald-950/20 hover:border-emerald-400/50'
                    : 'border-astral-700/30 bg-space-800/60 hover:border-astral-600/50 hover:bg-space-800/80'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border transition-colors ${
                        isOn
                          ? 'bg-emerald-500/15 border-emerald-400/35 text-emerald-300'
                          : 'bg-space-700/70 border-astral-700/40 text-astral-300/70 group-hover:text-astral-200'
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold text-white">{item.title}</h4>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider border ${
                            enabled === null
                              ? 'border-astral-700/40 bg-space-700/60 text-astral-300/60'
                              : isOn
                                ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                                : 'border-astral-700/40 bg-space-900/50 text-astral-300/50'
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              enabled === null
                                ? 'bg-astral-400 animate-pulse'
                                : isOn
                                  ? 'bg-emerald-400'
                                  : 'bg-astral-400/40'
                            }`}
                          />
                          {enabled === null ? 'Syncing' : isOn ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-astral-300/60 leading-relaxed">
                        {item.description}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={isOn}
                    aria-label={item.ariaLabel}
                    disabled={enabled === null || isSaving}
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleSetting(item.key);
                    }}
                    className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-gold-400/60 disabled:opacity-50 ${
                      isOn
                        ? 'bg-emerald-500 border-emerald-400/60 shadow-inner shadow-emerald-900/40'
                        : 'bg-space-950/80 border-astral-700/50'
                    }`}
                  >
                    <span
                      className={`inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-md transition-transform duration-200 ${
                        isOn ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    >
                      {isSaving && (
                        <LoaderCircle className="w-3 h-3 animate-spin text-space-900" />
                      )}
                    </span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="gold-divider opacity-40" />

      {/* ─── Section 2: CWL Clans ─── */}
      <section aria-labelledby="cwl-clans-heading" className="space-y-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gold-500/15 border border-gold-400/30 flex items-center justify-center text-gold-300">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h3 id="cwl-clans-heading" className="font-display text-lg font-bold text-white">
                  CWL Clans
                </h3>
                {!loading && (
                  <span className="rounded-full border border-gold-400/30 bg-gold-500/10 px-2.5 py-0.5 text-xs font-semibold text-gold-300 tabular-nums">
                    {clans.length}
                  </span>
                )}
              </div>
              <p className="text-xs text-astral-300/60">
                Our CWL lineup sorted by league — add a tag and details fill in automatically.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 self-start md:self-auto">
            <button
              type="button"
              onClick={() => setShowAdd((current) => !current)}
              className="astral-btn-primary text-sm"
              title="Add clan"
              aria-expanded={showAdd}
            >
              <Plus className="w-4 h-4" />
              {showAdd ? 'Close add panel' : 'Add clan'}
            </button>
            <button
              type="button"
              onClick={() => void handleRefreshAll()}
              disabled={deletingTag === '__refresh__'}
              className="astral-btn-ghost text-sm"
              title="Re-fetch all clans from the CoC API"
            >
              {deletingTag === '__refresh__' ? (
                <LoaderCircle className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              {deletingTag === '__refresh__' ? 'Refreshing...' : 'Refresh all'}
            </button>
          </div>
        </div>

        {showAdd && (
          <form
            onSubmit={handleAdd}
            className="astral-card p-5 border-gold-400/30 bg-gradient-to-br from-space-800/90 to-space-900/90 shadow-xl"
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2 text-gold-300 font-semibold text-sm">
                <Plus className="w-4 h-4" /> Add CWL Clan
              </div>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="p-1.5 text-astral-300/70 hover:text-white hover:bg-white/5 rounded-lg transition"
                title="Close add clan panel"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className="sr-only" htmlFor="cwl-add-clan-tag">
                  Clan Tag
                </label>
                <input
                  id="cwl-add-clan-tag"
                  required
                  maxLength={12}
                  value={tagInput}
                  onChange={(event) => setTagInput(normalizeTagInput(event.target.value))}
                  placeholder="Enter clan tag (e.g. #2Y08822)"
                  className="astral-input w-full uppercase font-mono"
                />
              </div>
              <button type="submit" disabled={saving} className="astral-btn-primary shrink-0">
                {saving ? (
                  <LoaderCircle className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                {saving ? 'Fetching...' : 'Fetch & add clan'}
              </button>
            </div>
            <p className="mt-2.5 text-xs text-astral-300/50">
              Name, CWL league, current leader, and clan badge are fetched live from the Clash of Clans API. Re-adding an existing tag refreshes its details.
            </p>
          </form>
        )}

        {loading ? (
          <div className="astral-card p-14 text-center text-astral-300/60">
            <LoaderCircle className="w-7 h-7 animate-spin mx-auto text-gold-300" />
            <p className="mt-3 text-sm">Loading CWL clans...</p>
          </div>
        ) : clans.length === 0 ? (
          <div className="astral-card p-14 text-center">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-astral-700/20 border border-astral-700/30 flex items-center justify-center">
              <Shield className="w-6 h-6 text-astral-300/50" />
            </div>
            <p className="mt-4 font-medium text-astral-100">No CWL clans in the lineup yet</p>
            <p className="mt-1 text-sm text-astral-300/50">
              Click <span className="text-gold-300 font-medium">Add clan</span> above to fetch your first CWL clan by tag.
            </p>
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {clans.map((clan) => {
              const badgeSrc = leagueBadgeSrc(clan.cwl_league);
              const isCopied = copiedTag === clan.clan_tag;

              return (
                <article
                  key={clan.clan_tag}
                  className="astral-card group overflow-hidden flex flex-col justify-between transition-all duration-200 hover:border-astral-500/40 hover:shadow-xl hover:shadow-space-950/70"
                >
                  <div className="p-5 flex items-start gap-4">
                    <div className="relative shrink-0">
                      {clan.badge_url ? (
                        <img
                          src={clan.badge_url}
                          alt=""
                          className="w-16 h-16 object-contain drop-shadow-md transition-transform duration-200 group-hover:scale-105"
                        />
                      ) : (
                        <div className="w-16 h-16 rounded-2xl bg-astral-700/30 border border-astral-700/40 flex items-center justify-center">
                          <Shield className="w-8 h-8 text-gold-300" />
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <h4 className="font-display text-lg font-bold text-white truncate">
                        {clan.clan_name ?? 'Unknown clan'}
                      </h4>

                      <button
                        type="button"
                        onClick={() => void copyClanTag(clan.clan_tag)}
                        className="mt-0.5 inline-flex items-center gap-1.5 text-xs font-mono text-gold-400/80 hover:text-gold-300 transition"
                        title="Click to copy clan tag"
                      >
                        <span>{clan.clan_tag}</span>
                        {isCopied ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3 opacity-60 group-hover:opacity-100 transition-opacity" />
                        )}
                      </button>

                      {clan.cwl_league && (
                        <div className="mt-2.5">
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-gold-400/30 bg-gold-500/10 px-2.5 py-1 text-xs font-medium text-gold-300">
                            {badgeSrc ? (
                              <img src={badgeSrc} alt="" className="w-4 h-4 object-contain" />
                            ) : (
                              <Trophy className="w-3.5 h-3.5" />
                            )}
                            {clan.cwl_league}
                          </span>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setPendingDelete(clan.clan_tag);
                        setError(null);
                        setMessage(null);
                      }}
                      disabled={deletingTag === clan.clan_tag}
                      className="p-2 text-astral-300/40 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg shrink-0 transition"
                      title={`Remove ${clan.clan_tag}`}
                    >
                      {deletingTag === clan.clan_tag ? (
                        <LoaderCircle className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  <div className="bg-space-900/35 border-t border-astral-700/20 divide-y divide-astral-700/15">
                    <div className="px-5 py-2.5 flex items-center gap-2 text-sm text-astral-200">
                      <User className="w-4 h-4 text-astral-300/60" />
                      <span className="text-astral-300/60 text-xs uppercase tracking-wide">
                        Leader
                      </span>
                      <span className="ml-auto font-medium text-white truncate">
                        {clan.leader_name ?? '—'}
                      </span>
                    </div>
                    <div className="px-5 py-2.5 flex items-center gap-2 text-sm text-astral-200">
                      <Swords className="w-4 h-4 text-astral-300/60" />
                      <span className="text-astral-300/60 text-xs uppercase tracking-wide">
                        In-game profile
                      </span>
                      <a
                        href={`https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodeURIComponent(clan.clan_tag)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto inline-flex items-center gap-1 font-medium text-xs text-gold-300 hover:text-gold-200 transition"
                      >
                        <span>Open in game</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Confirm removal">
          <div
            className="absolute inset-0 bg-space-950/70 backdrop-blur-sm"
            onClick={() => setPendingDelete(null)}
            aria-hidden="true"
          />
          <div className="relative bg-space-800 border border-astral-700/30 rounded-2xl p-6 w-full max-w-sm text-center shadow-2xl shadow-space-950">
            <div className="mx-auto w-12 h-12 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center">
              <Trash2 className="w-6 h-6 text-rose-300" />
            </div>
            <h3 className="mt-4 font-display text-lg font-bold text-white">Remove clan?</h3>
            <p className="mt-2 text-sm text-astral-200/70">
              <span className="font-semibold text-white">
                {clans.find((clan) => clan.clan_tag === pendingDelete)?.clan_name ?? 'Unknown clan'}
              </span>{' '}
              <span className="font-mono text-gold-300">({pendingDelete})</span> will be removed from the CWL directory. This cannot be undone.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="astral-btn-ghost justify-center"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(pendingDelete)}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-2.5 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/25"
              >
                <Trash2 className="w-4 h-4" /> Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
