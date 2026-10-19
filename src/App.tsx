import { useState, useCallback, useEffect } from 'react';
import {
  Sparkles,
  Search,
  Eye,
  EyeOff,
  AlertCircle,
  ChevronDown,
  Check,
  Copy,
  Info,
  X,
  LogIn,
  LogOut,
  Menu,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import Starfield from '@/components/Starfield';
import Sidebar from '@/components/Sidebar';
import ClanTable from '@/components/ClanTable';
import ClansPage from '@/components/ClansPage';
import AccountsPage from '@/components/AccountsPage';
import WarsPage from '@/components/WarsPage';
import { DEFAULT_COLUMNS } from '@/columns';
import { fetchClansFromSheet } from '@/sheetsFetcher';
import { supabase } from '@/supabaseClient';
import type {
  Clan,
  ActivePage,
  ColumnConfig,
  ColumnKey,
  SortState,
} from '@/types';
import { isClanPage } from '@/types';
import { buildAllMissingMentions } from '@/discordMentions';
import ClanHomePage from '@/components/ClanHomePage';
import ClanWarWeightsPage from '@/components/ClanWarWeightsPage';
import DeveloperDashboard from '@/components/DeveloperDashboard';

const DEFAULT_SHEET_URL =
  import.meta.env.VITE_SHEET_URL;
const SHEET_REFRESH_INTERVAL_MS = 60_000;

export default function App() {
  const [clans, setClans] = useState<Clan[]>([]);
  const [columns, setColumns] = useState<ColumnConfig[]>(DEFAULT_COLUMNS);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const [hiddenClans, setHiddenClans] = useState<Set<string>>(new Set());
  const [spunClans, setSpunClans] = useState<Set<string>>(new Set());

  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [allowedRole, setAllowedRole] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showProfile, setShowProfile] = useState(false);
  const [copiedMissing, setCopiedMissing] = useState(false);
  const [activePage, setActivePage] = useState<ActivePage>('roster');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(min-width: 1024px)').matches) setSidebarOpen(true);
  }, []);

  useEffect(() => {
    let active = true;

    if (!supabase) {
      setAuthLoading(false);
      return () => {
        active = false;
      };
    }
    const client = supabase;

    const checkAuthorization = async () => {
      const { data, error: userError } = await client.auth.getUser();
      if (userError) {
        if (active) {
          setError(`Could not verify your Discord login: ${userError.message}`);
          setAuthLoading(false);
        }
        return;
      }
      const authUser = data.user;

      if (!authUser) {
        if (active) setAuthLoading(false);
        return;
      }

      const { data: allowedRole, error: allowlistError } = await client.rpc(
        'get_my_allowed_role'
      );

      if (!active) return;
      if (allowlistError) {
        setError(`Could not check the allowed user list: ${allowlistError.message}`);
        setAuthLoading(false);
      } else if (allowedRole) {
        setUser(authUser);
        setAllowedRole(allowedRole);
      } else {
        await client.auth.signOut();
        window.location.replace('https://www.astralfwa.com/');
      }
      setAuthLoading(false);
    };

    void checkAuthorization();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        void checkAuthorization();
      } else {
        setUser(null);
        setAllowedRole(null);
      }
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const handleDiscordLogin = async () => {
    if (!supabase) {
      setError('Supabase is not configured yet. Add the values from your Supabase project to .env.local.');
      return;
    }

    const { error: loginError } = await supabase.auth.signInWithOAuth({
      provider: 'discord',
      options: { redirectTo: window.location.origin },
    });

    if (loginError) setError(loginError.message);
  };

  const handleSignOut = async () => {
    if (!supabase) return;
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) setError(signOutError.message);
  };

  const profileMetadata = user?.user_metadata ?? {};
  const discordIdentity = user?.identities?.find((identity) => identity.provider === 'discord');
  const discordData = discordIdentity?.identity_data ?? {};
  const removeDiscriminator = (value: unknown) =>
    typeof value === 'string' ? value.replace(/#0$/, '') : '';
  const username = removeDiscriminator(
    profileMetadata.user_name || discordData.username || profileMetadata.name
  ) || 'Not available';

  useEffect(() => {
    if (!user) return;

    if (!DEFAULT_SHEET_URL) {
      setError('The spreadsheet URL is not configured. Add VITE_SHEET_URL to .env.local and restart the app.');
      return;
    }

    const loadSpreadsheet = async () => {
      setError(null);
      setWarning(null);
      try {
        const result = await fetchClansFromSheet(DEFAULT_SHEET_URL, '', '');
        setClans(result.clans);
        setLastUpdated(new Date());
        if (result.clans.length === 0) {
          setError('No clan data found in the spreadsheet. Check its headers and sharing settings.');
        }
        if (result.warning) setWarning(result.warning);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch the spreadsheet.');
      }
    };

    void loadSpreadsheet();
    const refreshTimer = window.setInterval(() => void loadSpreadsheet(), SHEET_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(refreshTimer);
  }, [user]);

  const handleSort = useCallback(
    (column: ColumnKey) => {
      setSortState((prev) => {
        if (!prev || prev.column !== column) {
          return { column, direction: 'asc' };
        }
        if (prev.direction === 'asc') {
          return { column, direction: 'desc' };
        }
        return null;
      });
    },
    []
  );

  const toggleColumn = (key: ColumnKey) => {
    setColumns((prev) =>
      prev.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c))
    );
  };

  const hiddenCount = columns.filter((c) => !c.visible).length;

  const copyAllMissing = async () => {
    const value = buildAllMissingMentions(clans);
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedMissing(true);
      window.setTimeout(() => setCopiedMissing(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  const toggleClanHidden = (clanKey: string) => {
    setHiddenClans((prev) => {
      const next = new Set(prev);
      if (next.has(clanKey)) next.delete(clanKey);
      else next.add(clanKey);
      return next;
    });
  };

  const toggleClanSpun = (clanKey: string) => {
    setSpunClans((prev) => {
      const next = new Set(prev);
      if (next.has(clanKey)) next.delete(clanKey);
      else next.add(clanKey);
      return next;
    });
  };

  if (authLoading) {
    return <div className="min-h-screen bg-space-950" aria-label="Checking authorization" />;
  }

  if (!user) {
    return (
      <div className="min-h-screen relative flex items-center justify-center px-4">
        <Starfield />
        <main className="relative z-10 w-full max-w-md astral-card p-8 text-center">
          <div className="mx-auto mb-5 relative w-14 h-14">
            <img src="/astral.png" alt="Astral logo" className="w-14 h-14 rounded-xl object-contain shadow-lg shadow-astral-900/50" />
            <div className="absolute inset-0 rounded-xl border border-gold-400/20 animate-glow pointer-events-none" />
          </div>
          <h1 className="font-display text-2xl font-bold gold-text">Astral Management</h1>
          <p className="mt-2 text-sm text-astral-200/70">
            Authorize with Discord to access Astral Management.
          </p>
          <button
            onClick={handleDiscordLogin}
            className="astral-btn-primary w-full mt-6 justify-center"
          >
            <LogIn className="w-4 h-4" />
            Authorize with Discord
          </button>
          {error && (
            <p className="mt-4 text-sm text-rose-200" role="alert">
              {error}
            </p>
          )}
          {!supabase && (
            <p className="mt-4 text-xs text-amber-200/80">
              Supabase is not configured. Add the values from .env.local, then restart the app.
            </p>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative">
      <Starfield />
      <Sidebar
        open={sidebarOpen}
        activePage={activePage}
        onNavigate={(page) => {
          setActivePage(page);
          setSidebarOpen(false);
        }}
        onInitialNavigate={setActivePage}
        onClose={() => setSidebarOpen(false)}
      />

      <header className="sticky top-0 z-20 border-b border-astral-700/20 bg-space-900/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSidebarOpen((open) => !open)}
                className="astral-btn-ghost p-2"
                title="Open menu"
                aria-label="Open menu"
                aria-expanded={sidebarOpen}
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="relative w-11 h-11">
                <img src="/astral.png" alt="Astral logo" className="w-11 h-11 rounded-xl object-contain shadow-lg shadow-astral-900/50" />
                <div className="absolute inset-0 rounded-xl border border-gold-400/20 animate-glow pointer-events-none" />
              </div>
              <div>
                <h1 className="font-display text-xl sm:text-2xl font-bold gold-text leading-tight">
                  Astral Management
                </h1>
              </div>
            </div>

            <div className="relative">
              <button
                onClick={() => setShowProfile((visible) => !visible)}
                className="rounded-full focus:outline-none focus:ring-2 focus:ring-gold-400/70"
                title="Open Discord profile"
                aria-label="Open Discord profile"
                aria-expanded={showProfile}
              >
                {profileMetadata.avatar_url ? (
                  <img
                    src={profileMetadata.avatar_url}
                    alt=""
                    className="w-9 h-9 rounded-full object-cover border border-gold-400/60"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-astral-700/70 flex items-center justify-center border border-gold-400/60">
                    <Sparkles className="w-4 h-4 text-gold-300" />
                  </div>
                )}
              </button>
            </div>
          </div>
        </div>
      </header>

      {showProfile && (
        <section className="relative z-20 border-b border-astral-700/20 bg-space-800/80 backdrop-blur-md">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex justify-end">
            <div className="w-full sm:w-80 astral-card p-4 shadow-xl shadow-space-900/50">
              <div className="flex items-center gap-3 pb-3 border-b border-astral-700/30">
                {profileMetadata.avatar_url && (
                  <img
                    src={profileMetadata.avatar_url}
                    alt=""
                    className="w-11 h-11 rounded-full object-cover border border-gold-400/40"
                  />
                )}
                <div className={profileMetadata.avatar_url ? '' : 'pl-1'}>
                  <p className="font-semibold text-white truncate">@{username}</p>
                </div>
              </div>
              <dl className="py-3 space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-astral-300/60">Joined</dt>
                  <dd className="text-astral-100 text-right">
                    {new Date(user.created_at).toLocaleDateString()}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-astral-300/60">Role</dt>
                  <dd className="text-gold-300 capitalize">{allowedRole || 'Unknown'}</dd>
                </div>
              </dl>
              <button
                onClick={handleSignOut}
                className="astral-btn-ghost w-full justify-center text-sm border-t border-astral-700/30 pt-3 rounded-none"
              >
                <LogOut className="w-4 h-4" />
                Sign out
              </button>
            </div>
          </div>
        </section>
      )}

      {isClanPage(activePage)
        ? activePage.page === 'war-weights'
          ? <ClanWarWeightsPage clanTag={activePage.clanTag} clanName={activePage.clanName} />
          : <ClanHomePage clanTag={activePage.clanTag} clanName={activePage.clanName} />
        : activePage === 'developer' ? <DeveloperDashboard /> : activePage === 'accounts' ? <AccountsPage /> : activePage === 'wars' ? <WarsPage /> : activePage === 'clans' ? <ClansPage /> : <>

      {/* Toolbar */}
      <div className="relative z-30 sticky top-0 bg-space-900/80 backdrop-blur-md border-b border-astral-700/20 overflow-visible">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            {/* Search */}
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-astral-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search players, tags, clans..."
                className="astral-input w-full pl-10"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-astral-300/50 hover:text-white transition"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* Column toggle */}
              <div className="relative">
                <button
                  onClick={() => setShowColumnMenu((v) => !v)}
                  className="astral-btn-ghost text-sm"
                >
                  {showColumnMenu ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                  <span className="hidden sm:inline">Columns</span>
                  {hiddenCount > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 rounded-full bg-gold-500/20 text-gold-300 text-xs font-bold">
                      {hiddenCount} hidden
                    </span>
                  )}
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>

                {showColumnMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setShowColumnMenu(false)}
                    />
                    <div className="absolute right-0 mt-2 w-56 bg-space-900/95 border border-astral-700/50 rounded-2xl p-2 z-30 shadow-2xl shadow-space-950">
                      <p className="px-3 py-2 text-xs text-astral-300/60 font-medium uppercase tracking-wide">
                        Toggle Columns
                      </p>
                      {columns.map((col) => (
                        <button
                          key={col.key}
                          onClick={() => toggleColumn(col.key)}
                          className="flex items-center justify-between w-full px-3 py-2 rounded-lg hover:bg-astral-700/20 transition text-sm"
                        >
                          <span className={col.visible ? 'text-astral-100' : 'text-astral-300/40'}>
                            {col.label}
                          </span>
                          {col.visible ? (
                            <Eye className="w-4 h-4 text-gold-400" />
                          ) : (
                            <EyeOff className="w-4 h-4 text-astral-300/40" />
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              <button
                onClick={() => void copyAllMissing()}
                className="astral-btn-ghost text-sm"
                title="Copy all missing players"
                disabled={!buildAllMissingMentions(clans)}
              >
                {copiedMissing ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                <span className="hidden sm:inline">{copiedMissing ? 'Copied' : 'Copy Missing'}</span>
              </button>

            </div>
          </div>
        </div>
      </div>

      {/* Error / Warning */}
      {(error || warning) && (
        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 pt-4">
          {error && (
            <div className="flex items-start gap-3 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200">
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p className="text-sm">{error}</p>
              <button
                onClick={() => setError(null)}
                className="ml-auto text-rose-300/60 hover:text-white transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
          {warning && !error && (
            <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200">
              <Info className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p className="text-sm">{warning}</p>
              <button
                onClick={() => setWarning(null)}
                className="ml-auto text-amber-300/60 hover:text-white transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stats bar */}
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 pt-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-sm">
            <div className="w-2 h-2 rounded-full bg-gold-400 animate-twinkle" />
            <span className="text-astral-200">
              <span className="font-bold text-white">{clans.length}</span> clans
            </span>
          </div>
          {sortState && (
            <div className="flex items-center gap-2 text-sm">
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-astral-200">
                Sorted by{' '}
                <span className="text-gold-300 font-medium">
                  {columns.find((c) => c.key === sortState.column)?.label}
                </span>{' '}
                ({sortState.direction})
              </span>
              <button
                onClick={() => setSortState(null)}
                className="text-astral-300/50 hover:text-white transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
          {lastUpdated && (
            <p className="mt-2 text-xs text-astral-300/40">
              Spreadsheet updated {lastUpdated.toLocaleTimeString()}
            </p>
          )}
      </div>

      {/* Clan tables */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-8 pb-16">
        {[...clans]
          .sort((a, b) => {
            const aSpun = spunClans.has(a.clanTag || a.clanName);
            const bSpun = spunClans.has(b.clanTag || b.clanName);
            return Number(aSpun) - Number(bSpun);
          })
          .map((clan) => {
          const clanKey = clan.clanTag || clan.clanName;
          return (
            <ClanTable
              key={clanKey}
              clan={clan}
              columns={columns}
              onSort={handleSort}
              sortState={sortState}
              searchQuery={searchQuery}
              hidden={hiddenClans.has(clanKey)}
              onToggleHide={() => toggleClanHidden(clanKey)}
              spun={spunClans.has(clanKey)}
              onToggleSpun={() => toggleClanSpun(clanKey)}
            />
          );
          })}
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-astral-700/20 bg-space-900/40 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 text-center text-xs text-astral-300/40">
          Astral Management · Data from Google Sheets & the CoC API
        </div>
      </footer>
      </>}
    </div>
  );
}
