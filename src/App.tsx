import { useState, useCallback, useEffect } from 'react';
import {
  Sparkles,
  LogIn,
  LogOut,
  Menu,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import Starfield from '@/components/Starfield';
import Sidebar from '@/components/Sidebar';
import ClansPage from '@/components/ClansPage';
import EntriesPage from '@/components/EntriesPage';
import CwlRosterPage from '@/components/CwlRosterPage';
import AccountsPage from '@/components/AccountsPage';
import WarsPage from '@/components/WarsPage';
import { supabase } from '@/supabaseClient';
import type { ActivePage } from '@/types';
import { isClanPage } from '@/types';
import ClanHomePage from '@/components/ClanHomePage';
import ClanWarWeightsPage from '@/components/ClanWarWeightsPage';
import StrikeBoardPage from '@/components/StrikeBoardPage';
import StrikeManagerPage from '@/components/StrikeManagerPage';
import DeveloperDashboard from '@/components/DeveloperDashboard';

export default function App() {
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [allowedRole, setAllowedRole] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showProfile, setShowProfile] = useState(false);
  const [liveDiscordProfile, setLiveDiscordProfile] = useState<{
    discord_id: string | null;
    nickname: string | null;
    username: string | null;
    avatar_url: string | null;
  } | null>(null);
  const [activePage, setActivePage] = useState<ActivePage>('clans');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [sidebarReady, setSidebarReady] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(min-width: 1024px)').matches) setSidebarOpen(true);
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 300);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

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

  const profileMetadata = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const discordIdentity = user?.identities?.find((identity) => identity.provider === 'discord');
  const discordData = (discordIdentity?.identity_data ?? {}) as Record<string, unknown>;
  const customClaims = (profileMetadata.custom_claims ?? discordData.custom_claims ?? {}) as Record<string, unknown>;
  const removeDiscriminator = (value: unknown) =>
    typeof value === 'string' ? value.trim().replace(/#0$/, '') : '';

  const fallbackUsername =
    removeDiscriminator(profileMetadata.user_name || discordData.username || profileMetadata.name) ||
    'Not available';
  const fallbackNickname =
    (typeof profileMetadata.discord_nickname === 'string' && profileMetadata.discord_nickname.trim()) ||
    (typeof customClaims.global_name === 'string' && customClaims.global_name.trim()) ||
    (typeof profileMetadata.full_name === 'string' && profileMetadata.full_name.trim()) ||
    (typeof discordData.full_name === 'string' && discordData.full_name.trim()) ||
    fallbackUsername;
  const fallbackDiscordId = String(
    profileMetadata.provider_id ??
      discordIdentity?.id ??
      discordData.provider_id ??
      discordData.sub ??
      profileMetadata.sub ??
      ''
  ).trim();
  const fallbackAvatarUrl =
    (typeof profileMetadata.avatar_url === 'string' && profileMetadata.avatar_url.trim()) ||
    (typeof discordData.avatar_url === 'string' && discordData.avatar_url.trim()) ||
    null;

  const username = liveDiscordProfile?.username || fallbackUsername;
  const nickname = liveDiscordProfile?.nickname || fallbackNickname;
  const discordId = liveDiscordProfile?.discord_id || fallbackDiscordId || 'Not available';
  const avatarUrl = liveDiscordProfile?.avatar_url || fallbackAvatarUrl;

  const refreshDiscordProfile = useCallback(async () => {
    if (!supabase || !user) return;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return;
      const resp = await fetch('/api/discord-profile', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return;
      const body = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        discord_id?: string | null;
        nickname?: string | null;
        username?: string | null;
        avatar_url?: string | null;
      };
      if (body.ok) {
        setLiveDiscordProfile({
          discord_id: body.discord_id ?? null,
          nickname: body.nickname ?? null,
          username: body.username ?? null,
          avatar_url: body.avatar_url ?? null,
        });
      }
    } catch {
      // Ignore if running in local Vite dev without /api
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      void refreshDiscordProfile();
    } else {
      setLiveDiscordProfile(null);
    }
  }, [user, refreshDiscordProfile]);

  useEffect(() => {
    if (sidebarReady && initialLoading) {
      setInitialLoading(false);
    }
  }, [sidebarReady, initialLoading]);

  const handleSidebarReady = useCallback(() => setSidebarReady(true), []);

  // Show loading screen while auth is in progress
  if (authLoading) {
    return (
      <div className="min-h-screen relative flex items-center justify-center">
        <Starfield />
        <div className="text-center">
          <div className="mx-auto mb-6 relative w-16 h-16">
            <img src="/astral.png" alt="Astral logo" className="w-16 h-16 rounded-xl object-contain shadow-lg shadow-astral-900/50" />
            <div className="absolute inset-0 rounded-xl border border-gold-400/20 animate-glow pointer-events-none" />
          </div>
          <h1 className="font-display text-2xl font-bold gold-text">Astral Management is loading...</h1>
          <p className="mt-2 text-sm text-astral-200/70">Please wait while we load your data.</p>
        </div>
      </div>
    );
  }

  // Show login page if not authenticated
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

  // Main app - Sidebar renders immediately so it can load data in background
  // Loading overlay shows until sidebar data is loaded
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
        onReady={handleSidebarReady}
      />

      {/* Loading overlay — shows until both sheet data and sidebar data are loaded */}
      {initialLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-space-950">
          <div className="text-center">
            <div className="mx-auto mb-6 relative w-16 h-16">
              <img src="/astral.png" alt="Astral logo" className="w-16 h-16 rounded-xl object-contain shadow-lg shadow-astral-900/50" />
              <div className="absolute inset-0 rounded-xl border border-gold-400/20 animate-glow pointer-events-none" />
            </div>
            <h1 className="font-display text-2xl font-bold gold-text">Astral Management is loading...</h1>
            <p className="mt-2 text-sm text-astral-200/70">Please wait while we load your data.</p>
          </div>
        </div>
      )}

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
                onClick={() => {
                  setShowProfile((visible) => {
                    const next = !visible;
                    if (next) void refreshDiscordProfile();
                    return next;
                  });
                }}
                className="rounded-full focus:outline-none focus:ring-2 focus:ring-gold-400/70"
                title="Open Discord profile"
                aria-label="Open Discord profile"
                aria-expanded={showProfile}
              >
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
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
              <div className="flex items-start gap-3.5 pb-3.5">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt=""
                    className="w-14 h-14 rounded-full object-cover border border-gold-400/50 shrink-0 shadow-md shadow-space-950/60"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-full bg-astral-700/70 flex items-center justify-center border border-gold-400/50 shrink-0">
                    <Sparkles className="w-6 h-6 text-gold-300" />
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-semibold text-base text-white leading-tight truncate">
                    {nickname}
                  </p>
                  <p className="text-xs text-astral-200/80 truncate">
                    @{username}
                  </p>
                  <p className="text-xs text-astral-300/70 truncate">
                    Discord ID: <span className="font-mono text-astral-100">{discordId}</span>
                  </p>
                  <p className="text-xs text-astral-300/70 pt-0.5">
                    Role: <span className="text-gold-300 font-medium capitalize">{allowedRole || 'Unknown'}</span>
                  </p>
                </div>
              </div>
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

      {/* Active page */}
      {isClanPage(activePage)
        ? activePage.page === 'war-weights'
          ? <ClanWarWeightsPage clanTag={activePage.clanTag} clanName={activePage.clanName} />
          : activePage.page === 'strike-board'
            ? <StrikeBoardPage clanTag={activePage.clanTag} clanName={activePage.clanName} />
            : activePage.page === 'strike-manager'
              ? <StrikeManagerPage clanTag={activePage.clanTag} clanName={activePage.clanName} />
              : <ClanHomePage clanTag={activePage.clanTag} clanName={activePage.clanName} />
        : activePage === 'developer' ? <DeveloperDashboard />
        : activePage === 'accounts' ? <AccountsPage />
        : activePage === 'wars' ? <WarsPage />
        : activePage === 'clans' ? <ClansPage />
        : activePage === 'entries' ? <EntriesPage />
        : activePage === 'cwlroster' ? <CwlRosterPage />
        : null}

      {/* Footer */}
      <footer className="relative z-10 border-t border-astral-700/20 bg-space-900/40 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 text-center text-xs text-astral-300/40">
          Astral Management · Data from Google Sheets & the CoC API
        </div>
      </footer>

      {scrolled && (
        <button
          onClick={scrollToTop}
          className="fixed bottom-6 right-6 z-50 astral-btn-primary rounded-full p-3"
          aria-label="Scroll to top"
        >
          <span className="sr-only">Scroll to top</span>
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}
