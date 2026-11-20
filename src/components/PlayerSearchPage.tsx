import { useState, useRef, useEffect } from 'react';
import {
  Search,
  Copy,
  Check,
  ExternalLink,
  AlertCircle,
  LoaderCircle,
  Shield,
  Crown,
  Sparkles,
  AlertTriangle,
  History,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';

interface PlayerLabel {
  id: number;
  name: string;
  iconUrls?: { small?: string; medium?: string };
}

interface HeroEquipment {
  name: string;
  level: number;
  maxLevel: number;
  village: string;
}

interface PlayerHero {
  name: string;
  level: number;
  maxLevel: number;
  village: string;
  equipment?: HeroEquipment[];
}

interface SearchedPlayer {
  tag: string;
  name: string;
  townHallLevel: number | null;
  townHallWeaponLevel: number | null;
  expLevel: number | null;
  trophies: number;
  bestTrophies: number;
  warStars: number;
  role: string | null;
  warPreference: 'in' | 'out' | null;
  donations: number;
  donationsReceived: number;
  clan: {
    tag: string;
    name: string;
    clanLevel?: number;
    badgeUrls?: { small?: string; medium?: string; large?: string };
  } | null;
  league: {
    id: number;
    name: string;
    iconUrls?: { small?: string; tiny?: string; medium?: string };
  } | null;
  leagueTier: {
    id: number;
    name: string;
    iconUrls?: { small?: string; large?: string };
  } | null;
  labels: PlayerLabel[];
  heroes: PlayerHero[];
  friendInNeed: {
    value: number;
    target: number;
    stars: number;
  } | null;
}

interface DiscordLinkedProfile {
  discord_id: string;
  nickname: string;
  username: string;
  avatar_url: string | null;
}

interface StrikeEntry {
  id: string;
  clan_tag: string;
  clan_name: string;
  value: number;
  reason: string;
  note: string | null;
  issued_date: string | null;
  confirmed_by: string | null;
  edited_by: string | null;
}

interface SeasonStrikesGroup {
  season: string;
  total: number;
  strikes: StrikeEntry[];
}

interface PlayerSearchResponse {
  ok: boolean;
  error?: string;
  player?: SearchedPlayer;
  discord?: DiscordLinkedProfile | null;
  strikes?: {
    current_season: {
      total: number;
      strikes: StrikeEntry[];
    };
    past_seasons: SeasonStrikesGroup[];
  };
}

const RECENT_SEARCHES_KEY = 'astral_recent_player_searches';

function formatInGameRole(role: string | null): string {
  if (!role) return 'No Clan';
  const r = role.toLowerCase();
  if (r === 'leader') return 'Leader';
  if (r === 'coleader' || r === 'co-leader') return 'Co-Leader';
  if (r === 'admin' || r === 'elder') return 'Elder';
  if (r === 'member') return 'Member';
  return role;
}

function roleBadgeClasses(role: string | null): string {
  const formatted = formatInGameRole(role);
  if (formatted === 'Leader') {
    return 'bg-gold-500/20 text-gold-300 border-gold-400/40';
  }
  if (formatted === 'Co-Leader') {
    return 'bg-astral-500/20 text-astral-200 border-astral-400/40';
  }
  if (formatted === 'Elder') {
    return 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30';
  }
  return 'bg-space-700/80 text-astral-200/80 border-astral-700/40';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function strikeValueColor(value: number): string {
  if (value <= 0) return 'text-emerald-300';
  if (value < 1.5) return 'text-amber-300';
  if (value < 2.5) return 'text-amber-400';
  return 'text-rose-300';
}

function getTownHallImage(level: number | null): string | null {
  if (!level || level < 1) return null;
  const clamped = Math.min(Math.max(Math.round(level), 1), 19);
  return `/${clamped}.png`;
}

export default function PlayerSearchPage() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PlayerSearchResponse | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showDiscordPopup, setShowDiscordPopup] = useState(false);
  const [recentTags, setRecentTags] = useState<{ tag: string; name: string }[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
    } catch {
      return [];
    }
  });

  const discordPopupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        discordPopupRef.current &&
        !discordPopupRef.current.contains(event.target as Node)
      ) {
        setShowDiscordPopup(false);
      }
    };
    if (showDiscordPopup) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showDiscordPopup]);

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1600);
    } catch {
      // ignore clipboard errors
    }
  };

  const saveRecentSearch = (tag: string, name: string) => {
    setRecentTags((prev) => {
      const next = [
        { tag, name },
        ...prev.filter((item) => item.tag.toUpperCase() !== tag.toUpperCase()),
      ].slice(0, 6);
      try {
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const executeSearch = async (rawTagInput: string) => {
    const trimmed = rawTagInput.trim();
    if (!trimmed) {
      setError('Please enter a player tag (e.g. #2PP).');
      return;
    }
    if (!supabase) {
      setError('Supabase is not configured.');
      return;
    }

    setLoading(true);
    setError(null);
    setShowDiscordPopup(false);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const response = await fetch(
        `/api/player-search?tag=${encodeURIComponent(trimmed)}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );

      const body = (await response.json().catch(() => ({}))) as PlayerSearchResponse;
      if (!response.ok || !body.ok || !body.player) {
        throw new Error(body.error || `Failed to fetch player (HTTP ${response.status}).`);
      }

      setData(body);
      setQuery(body.player.tag);
      saveRecentSearch(body.player.tag, body.player.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load player profile.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void executeSearch(query);
  };

  const player = data?.player;
  const discord = data?.discord;
  const strikes = data?.strikes;

  const hasCurrentStrikes = (strikes?.current_season.strikes.length ?? 0) > 0;
  const hasPastStrikes = (strikes?.past_seasons.length ?? 0) > 0;
  const hasAnyStrikes = hasCurrentStrikes || hasPastStrikes;

  const thImage = player ? getTownHallImage(player.townHallLevel) : null;
  const leagueIconUrl =
    player?.league?.iconUrls?.medium ||
    player?.league?.iconUrls?.small ||
    player?.leagueTier?.iconUrls?.large ||
    player?.leagueTier?.iconUrls?.small ||
    '/Unranked.webp';
  const leagueName = player?.league?.name || player?.leagueTier?.name || 'Unranked';

  const clanInGameUrl = player?.clan
    ? `https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodeURIComponent(
        player.clan.tag.replace(/^#+/, '')
      )}`
    : null;

  const playerInGameUrl = player
    ? `https://link.clashofclans.com/en?action=OpenPlayerProfile&tag=${encodeURIComponent(
        player.tag.replace(/^#+/, '')
      )}`
    : null;

  return (
    <main className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 py-8 pb-20 space-y-6">
      {/* Page Title & Search Bar */}
      <div className="astral-card p-6 sm:p-8 shadow-xl shadow-space-950/60">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-astral-600 to-astral-800 border border-gold-400/30 flex items-center justify-center shadow-lg shadow-astral-950/60">
                <Search className="w-5 h-5 text-gold-300" />
              </div>
              <div>
                <h2 className="font-display text-2xl sm:text-3xl font-bold gold-text">
                  Player Search
                </h2>
                <p className="text-xs sm:text-sm text-astral-200/70">
                  Look up any Clash of Clans player tag for live stats, Discord link, and seasonal strike records
                </p>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="flex items-center gap-2.5 w-full md:w-auto">
            <div className="relative flex-1 md:w-72">
              <Search className="w-4 h-4 text-astral-300/50 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter player tag (e.g. #2PP)"
                className="astral-input w-full pl-10 pr-9 font-mono text-sm uppercase"
                aria-label="Player Tag"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-astral-300/50 hover:text-white rounded-md transition"
                  title="Clear input"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <button
              type="submit"
              disabled={loading}
              className="astral-btn-primary shrink-0 px-5"
            >
              {loading ? (
                <>
                  <LoaderCircle className="w-4 h-4 animate-spin" />
                  <span>Searching...</span>
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  <span>Search</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Recent Searches */}
        {recentTags.length > 0 && (
          <div className="mt-4 pt-4 border-t border-astral-700/25 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider font-semibold text-astral-300/50 mr-1">
              Recent:
            </span>
            {recentTags.map((item) => (
              <button
                key={item.tag}
                type="button"
                onClick={() => {
                  setQuery(item.tag);
                  void executeSearch(item.tag);
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-space-900/70 hover:bg-astral-700/30 border border-astral-700/40 text-astral-200 hover:text-white transition"
              >
                <span className="font-medium text-white">{item.name}</span>
                <span className="font-mono text-gold-400/80">{item.tag}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Error Alert */}
      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <p className="text-sm flex-1">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="p-1 rounded-lg opacity-60 hover:opacity-100 hover:bg-white/10 transition shrink-0"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Empty State */}
      {!player && !loading && !error && (
        <div className="astral-card p-14 text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-astral-800/40 border border-astral-600/30 flex items-center justify-center mb-4">
            <Search className="w-7 h-7 text-gold-400/80" />
          </div>
          <h3 className="font-display text-lg font-bold text-white">
            Search for a Player by Tag
          </h3>
          <p className="mt-1.5 text-sm text-astral-300/60 max-w-md mx-auto">
            Enter a Clash of Clans player tag above to view their Town Hall, War Stars, Friend in Need donations, Heroes, Clan, Discord account, and Strike history.
          </p>
        </div>
      )}

      {/* Main Big Player Card */}
      {player && (
        <article className="astral-card overflow-hidden shadow-2xl shadow-space-950/80 border border-astral-600/40">
          {/* ─── Top Banner: Town Hall, Name/Tag, Discord Pill, Player Labels ─── */}
          <div className="relative p-6 sm:p-8 bg-gradient-to-br from-space-700/90 via-space-800/80 to-astral-950/60 border-b border-astral-700/40">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
              {/* Left: Town Hall Image + Identity */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-5">
                {/* Town Hall Visual Box */}
                <div className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-2xl bg-space-900/80 border border-gold-400/35 flex flex-col items-center justify-center p-2 shadow-xl shadow-space-950/70 shrink-0 group">
                  {thImage ? (
                    <img
                      src={thImage}
                      alt={`Town Hall ${player.townHallLevel}`}
                      className="w-16 h-16 sm:w-20 sm:h-20 object-contain drop-shadow-[0_4px_10px_rgba(0,0,0,0.6)] transition-transform duration-300 group-hover:scale-105"
                    />
                  ) : (
                    <Shield className="w-12 h-12 text-gold-400/60" />
                  )}
                  <span className="mt-1 px-2 py-0.5 rounded-md bg-gradient-to-r from-gold-500/25 to-amber-500/20 border border-gold-400/40 text-[11px] font-bold text-gold-200 tracking-wide">
                    TH {player.townHallLevel ?? '?'}
                    {player.townHallWeaponLevel ? ` ★${player.townHallWeaponLevel}` : ''}
                  </span>
                </div>

                {/* Player Name, Tag, Discord Link */}
                <div className="space-y-2.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    {player.expLevel != null && (
                      <span
                        className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-lg bg-sky-500/20 border border-sky-400/40 text-xs font-bold text-sky-200 shadow-sm"
                        title="Experience Level"
                      >
                        LVL {player.expLevel}
                      </span>
                    )}
                    <h3 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-wide truncate">
                      {player.name}
                    </h3>
                  </div>

                  {/* Player Tag + Copy + Visit in-game */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void copyText(player.tag, 'player-tag')}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-space-900/80 hover:bg-space-900 border border-gold-400/30 text-gold-300 font-mono text-sm transition"
                      title="Click to copy player tag"
                    >
                      <span>{player.tag}</span>
                      {copiedKey === 'player-tag' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 text-gold-400/70" />
                      )}
                    </button>

                    {playerInGameUrl && (
                      <a
                        href={playerInGameUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-astral-700/25 hover:bg-astral-600/35 border border-astral-500/35 text-xs font-medium text-astral-100 hover:text-white transition"
                      >
                        <span>Open Profile</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>

                  {/* Linked Discord Badge + Popup */}
                  {discord && (
                    <div className="pt-1 flex items-center gap-2.5 flex-wrap">
                      <span className="text-xs font-medium text-astral-300/80">
                        Linked to:
                      </span>
                      <div className="relative inline-block" ref={discordPopupRef}>
                        <button
                          type="button"
                          onClick={() => setShowDiscordPopup((prev) => !prev)}
                          className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-[#2b224c]/90 hover:bg-[#372b61] border border-astral-400/60 shadow-md shadow-astral-950/60 transition cursor-pointer group"
                          title="Click to view Discord details"
                          aria-expanded={showDiscordPopup}
                        >
                          {discord.avatar_url ? (
                            <img
                              src={discord.avatar_url}
                              alt={discord.nickname}
                              className="w-5 h-5 rounded-full object-cover border border-astral-300/40 shrink-0"
                            />
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-astral-700 flex items-center justify-center shrink-0">
                              <Sparkles className="w-3 h-3 text-astral-200" />
                            </div>
                          )}
                          <span className="text-sm font-semibold text-[#c9cdfb] group-hover:text-white transition">
                            @{discord.nickname}
                          </span>
                        </button>

                        {/* Clickable Popup Over/Below Discord Pill */}
                        {showDiscordPopup && (
                          <div className="absolute left-0 mt-2 w-72 z-30 rounded-2xl bg-space-800/95 backdrop-blur-xl border border-astral-500/50 p-4 shadow-2xl shadow-space-950 animate-in fade-in duration-150">
                            <div className="flex items-start justify-between gap-3 pb-3 border-b border-astral-700/40">
                              <div className="flex items-center gap-3 min-w-0">
                                {discord.avatar_url ? (
                                  <img
                                    src={discord.avatar_url}
                                    alt={discord.nickname}
                                    className="w-11 h-11 rounded-full object-cover border border-astral-400/60 shrink-0"
                                  />
                                ) : (
                                  <div className="w-11 h-11 rounded-full bg-astral-700 flex items-center justify-center border border-astral-400/60 shrink-0">
                                    <Sparkles className="w-5 h-5 text-gold-300" />
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <p className="text-sm font-bold text-white truncate">
                                    {discord.nickname}
                                  </p>
                                  <p className="text-xs text-astral-300 truncate">
                                    @{discord.username}
                                  </p>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => setShowDiscordPopup(false)}
                                className="p-1 rounded-lg text-astral-300/60 hover:text-white hover:bg-astral-700/30 transition"
                                aria-label="Close Discord popup"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>

                            <div className="mt-3 space-y-2 text-xs">
                              <div className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-space-900/60">
                                <span className="text-astral-300/70">Nickname</span>
                                <span className="font-medium text-white truncate max-w-[150px]">
                                  {discord.nickname}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-space-900/60">
                                <span className="text-astral-300/70">Username</span>
                                <button
                                  type="button"
                                  onClick={() => void copyText(discord.username, 'discord-username')}
                                  className="inline-flex items-center gap-1 font-mono text-astral-100 hover:text-gold-300 transition truncate max-w-[150px]"
                                  title="Copy username"
                                >
                                  <span className="truncate">@{discord.username}</span>
                                  {copiedKey === 'discord-username' ? (
                                    <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                                  ) : (
                                    <Copy className="w-3 h-3 opacity-60 shrink-0" />
                                  )}
                                </button>
                              </div>
                              <div className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-space-900/60">
                                <span className="text-astral-300/70">User ID</span>
                                <button
                                  type="button"
                                  onClick={() => void copyText(discord.discord_id, 'discord-id')}
                                  className="inline-flex items-center gap-1 font-mono text-gold-300 hover:text-gold-200 transition"
                                  title="Copy User ID"
                                >
                                  <span>{discord.discord_id}</span>
                                  {copiedKey === 'discord-id' ? (
                                    <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                                  ) : (
                                    <Copy className="w-3 h-3 opacity-70 shrink-0" />
                                  )}
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Player Labels with Icons */}
              {player.labels && player.labels.length > 0 && (
                <div className="flex flex-wrap items-center gap-2.5 lg:justify-end">
                  {player.labels.map((label) => {
                    const icon = label.iconUrls?.medium || label.iconUrls?.small;
                    return (
                      <div
                        key={label.id}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-space-900/75 border border-astral-600/35 shadow-md"
                      >
                        {icon && (
                          <img
                            src={icon}
                            alt={label.name}
                            className="w-6 h-6 object-contain"
                          />
                        )}
                        <span className="text-xs font-semibold text-astral-100">
                          {label.name}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ─── Core Highlights Grid: Clan + Role, League, War Stars, Friend in Need ─── */}
          <div className="p-6 sm:p-8 space-y-8">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* 1. Current Clan & In-Game Role (Clickable to visit in-game) */}
              {player.clan && clanInGameUrl ? (
                <a
                  href={clanInGameUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group relative flex flex-col justify-between p-4 rounded-2xl bg-space-900/70 hover:bg-astral-900/40 border border-astral-600/35 hover:border-gold-400/50 transition-all duration-200 shadow-lg"
                  title="Tap to visit clan in Clash of Clans"
                >
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-astral-300/60">
                      Current Clan
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-gold-300/90 group-hover:text-gold-200">
                      <span>Visit in-game</span>
                      <ExternalLink className="w-3 h-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </span>
                  </div>

                  <div className="flex items-center gap-3.5">
                    {player.clan.badgeUrls?.medium || player.clan.badgeUrls?.small ? (
                      <img
                        src={player.clan.badgeUrls.medium || player.clan.badgeUrls.small}
                        alt={player.clan.name}
                        className="w-12 h-12 object-contain drop-shadow shrink-0"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-xl bg-astral-800/60 flex items-center justify-center shrink-0">
                        <Shield className="w-6 h-6 text-gold-300" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-display font-bold text-base text-white group-hover:text-gold-200 transition truncate">
                        {player.clan.name}
                      </p>
                      <p className="font-mono text-xs text-astral-300/70 truncate">
                        {player.clan.tag}
                        {player.clan.clanLevel ? ` · Lv. ${player.clan.clanLevel}` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-astral-700/25 flex items-center justify-between">
                    <span className="text-xs text-astral-300/60">In-Game Role</span>
                    <span
                      className={`px-2.5 py-0.5 rounded-md text-xs font-semibold border ${roleBadgeClasses(
                        player.role
                      )}`}
                    >
                      {formatInGameRole(player.role)}
                    </span>
                  </div>
                </a>
              ) : (
                <div className="flex flex-col justify-between p-4 rounded-2xl bg-space-900/70 border border-astral-700/30 shadow-lg">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-astral-300/60">
                    Current Clan
                  </span>
                  <div className="flex items-center gap-3 my-3">
                    <div className="w-12 h-12 rounded-xl bg-space-800 border border-astral-700/40 flex items-center justify-center">
                      <Shield className="w-6 h-6 text-astral-400/40" />
                    </div>
                    <div>
                      <p className="font-semibold text-base text-astral-200/80">No Clan</p>
                      <p className="text-xs text-astral-300/50">Not currently in a clan</p>
                    </div>
                  </div>
                  <div className="pt-2.5 border-t border-astral-700/25 flex items-center justify-between">
                    <span className="text-xs text-astral-300/60">In-Game Role</span>
                    <span className="text-xs text-astral-300/50">—</span>
                  </div>
                </div>
              )}

              {/* 2. Current League with Icon */}
              <div className="flex flex-col justify-between p-4 rounded-2xl bg-space-900/70 border border-astral-700/30 shadow-lg">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-astral-300/60">
                    Current League
                  </span>
                  <span className="font-mono text-xs text-gold-300 font-semibold">
                    🏆 {player.trophies.toLocaleString()}
                  </span>
                </div>

                <div className="flex items-center gap-3.5">
                  <img
                    src={leagueIconUrl}
                    alt={leagueName}
                    className="w-12 h-12 object-contain drop-shadow shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-display font-bold text-base text-white truncate">
                      {leagueName}
                    </p>
                    <p className="text-xs text-astral-300/70">
                      {player.trophies.toLocaleString()} Trophies
                    </p>
                  </div>
                </div>

                <div className="mt-3 pt-2.5 border-t border-astral-700/25 flex items-center justify-between text-xs">
                  <span className="text-astral-300/60">All-Time Best</span>
                  <span className="font-mono font-semibold text-astral-100">
                    {player.bestTrophies.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* 3. War Stars (using uploaded /war_star.png) */}
              <div className="flex flex-col justify-between p-4 rounded-2xl bg-space-900/70 border border-astral-700/30 shadow-lg">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-astral-300/60">
                    War Stars
                  </span>
                  {player.warPreference && (
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                        player.warPreference === 'in'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                      }`}
                    >
                      War Opt-{player.warPreference}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3.5">
                  <img
                    src="/war_star.png"
                    alt="War Stars"
                    className="w-12 h-12 object-contain drop-shadow shrink-0"
                  />
                  <div>
                    <p className="font-display font-bold text-2xl gold-text">
                      {player.warStars.toLocaleString()}
                    </p>
                    <p className="text-xs text-astral-300/70">Total War Stars Won</p>
                  </div>
                </div>

                <div className="mt-3 pt-2.5 border-t border-astral-700/25 flex items-center justify-between text-xs">
                  <span className="text-astral-300/60">Town Hall Level</span>
                  <span className="font-mono font-semibold text-gold-300">
                    TH {player.townHallLevel ?? '—'}
                  </span>
                </div>
              </div>

              {/* 4. Friend in Need (using uploaded /FIN.webp) */}
              <div className="flex flex-col justify-between p-4 rounded-2xl bg-space-900/70 border border-astral-700/30 shadow-lg">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-astral-300/60">
                    Friend in Need
                  </span>
                  {player.friendInNeed && (
                    <span className="text-xs text-gold-400 font-semibold">
                      {'★'.repeat(player.friendInNeed.stars)}
                      {'☆'.repeat(Math.max(0, 3 - player.friendInNeed.stars))}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3.5">
                  <img
                    src="/FIN.webp"
                    alt="Friend in Need"
                    className="w-12 h-12 rounded-lg object-contain drop-shadow shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="font-display font-bold text-2xl text-white">
                      {(player.friendInNeed?.value ?? 0).toLocaleString()}
                    </p>
                    <p className="text-xs text-astral-300/70 truncate">
                      Lifetime Donations
                    </p>
                  </div>
                </div>

                <div className="mt-3 pt-2.5 border-t border-astral-700/25 flex items-center justify-between text-xs">
                  <span className="text-astral-300/60">Season Donated / Rec</span>
                  <span className="font-mono font-semibold text-astral-100">
                    {player.donations.toLocaleString()} / {player.donationsReceived.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            {/* ─── Hero Levels Section ─── */}
            <div>
              <div className="flex items-center justify-between mb-3.5">
                <div className="flex items-center gap-2">
                  <Crown className="w-4 h-4 text-gold-400" />
                  <h4 className="font-display text-base font-bold text-white tracking-wide">
                    Hero Levels
                  </h4>
                </div>
                {player.heroes.length > 0 && (
                  <span className="text-xs text-astral-300/60">
                    {player.heroes.reduce((sum, h) => sum + h.level, 0)} /{' '}
                    {player.heroes.reduce((sum, h) => sum + h.maxLevel, 0)} Total Hero Levels
                  </span>
                )}
              </div>

              {player.heroes.length === 0 ? (
                <div className="p-4 rounded-xl bg-space-900/50 border border-astral-700/25 text-sm text-astral-300/60">
                  No Home Village heroes unlocked yet.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  {player.heroes.map((hero) => {
                    const isMax = hero.level >= hero.maxLevel;
                    const pct =
                      hero.maxLevel > 0
                        ? Math.min(100, Math.round((hero.level / hero.maxLevel) * 100))
                        : 100;
                    return (
                      <div
                        key={hero.name}
                        className={`p-3.5 rounded-xl border transition ${
                          isMax
                            ? 'bg-gradient-to-b from-gold-500/10 to-space-900/80 border-gold-400/40'
                            : 'bg-space-900/70 border-astral-700/35'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-sm text-white truncate">
                            {hero.name}
                          </p>
                          {isMax && (
                            <span className="px-1.5 py-0.5 rounded bg-gold-500/20 text-gold-300 text-[10px] font-bold uppercase">
                              MAX
                            </span>
                          )}
                        </div>

                        <div className="mt-2 flex items-baseline justify-between">
                          <span
                            className={`font-mono text-lg font-bold ${
                              isMax ? 'text-gold-300' : 'text-astral-100'
                            }`}
                          >
                            Lv. {hero.level}
                          </span>
                          <span className="font-mono text-xs text-astral-300/60">
                            / {hero.maxLevel}
                          </span>
                        </div>

                        {/* Progress bar */}
                        <div className="mt-2 h-1.5 w-full rounded-full bg-space-800 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              isMax
                                ? 'bg-gradient-to-r from-gold-400 to-amber-300'
                                : 'bg-gradient-to-r from-astral-600 to-astral-400'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>

                        {/* Equipped Hero Equipment (if any) */}
                        {hero.equipment && hero.equipment.length > 0 && (
                          <div className="mt-2.5 pt-2 border-t border-astral-700/25 space-y-1">
                            {hero.equipment.map((eq) => (
                              <div
                                key={eq.name}
                                className="flex items-center justify-between text-[11px] text-astral-200/80"
                              >
                                <span className="truncate pr-1">{eq.name}</span>
                                <span
                                  className={`font-mono shrink-0 ${
                                    eq.level >= eq.maxLevel
                                      ? 'text-gold-300 font-semibold'
                                      : 'text-astral-300/70'
                                  }`}
                                >
                                  Lv.{eq.level}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ─── Strikes Section (Grouped by Seasons: Current & Past) ─── */}
            {hasAnyStrikes && strikes && (
              <div className="pt-2 border-t border-astral-700/30 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                    <h4 className="font-display text-base font-bold text-white tracking-wide">
                      Strike History by Season
                    </h4>
                  </div>
                  <span className="text-xs text-astral-300/60">
                    Active:{' '}
                    <strong className={strikeValueColor(strikes.current_season.total)}>
                      {strikes.current_season.total}
                    </strong>{' '}
                    · Past Seasons: <strong>{strikes.past_seasons.length}</strong>
                  </span>
                </div>

                <div className="space-y-4">
                  {/* Current Season Card */}
                  {hasCurrentStrikes && (
                    <div className="rounded-2xl bg-space-900/75 border border-amber-500/35 overflow-hidden">
                      <div className="px-5 py-3.5 bg-gradient-to-r from-amber-500/15 via-space-800/60 to-space-900/60 border-b border-amber-500/25 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <span className="px-2.5 py-0.5 rounded-md bg-amber-500/20 border border-amber-400/40 text-xs font-bold text-amber-200 uppercase tracking-wider">
                            Current Season
                          </span>
                          <span className="text-xs text-astral-200/70">
                            {strikes.current_season.strikes.length} active record(s)
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="text-xs text-astral-300/60 mr-2">Total:</span>
                          <span
                            className={`font-mono text-lg font-bold ${strikeValueColor(
                              strikes.current_season.total
                            )}`}
                          >
                            {strikes.current_season.total}
                          </span>
                        </div>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-space-800/60 text-left text-xs text-astral-300/60">
                              <th className="px-4 py-2.5 font-medium">Value</th>
                              <th className="px-4 py-2.5 font-medium">Reason</th>
                              <th className="px-4 py-2.5 font-medium">Note</th>
                              <th className="px-4 py-2.5 font-medium">Clan</th>
                              <th className="px-4 py-2.5 font-medium">Issued Date</th>
                              <th className="px-4 py-2.5 font-medium">Confirmed By</th>
                            </tr>
                          </thead>
                          <tbody>
                            {strikes.current_season.strikes.map((s) => (
                              <tr
                                key={s.id}
                                className="border-t border-astral-700/20 hover:bg-astral-700/10 transition"
                              >
                                <td className="px-4 py-2.5 font-mono font-bold">
                                  <span className={strikeValueColor(s.value)}>
                                    {s.value > 0 ? `+${s.value}` : s.value}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 text-white font-medium">
                                  {s.reason || '—'}
                                </td>
                                <td className="px-4 py-2.5 text-astral-300/70">
                                  {s.note || '—'}
                                </td>
                                <td className="px-4 py-2.5 text-astral-200">
                                  {s.clan_name}
                                </td>
                                <td className="px-4 py-2.5 font-mono text-xs text-astral-200">
                                  {formatDate(s.issued_date)}
                                </td>
                                <td className="px-4 py-2.5 text-xs text-astral-300/70">
                                  {s.confirmed_by || '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Past Seasons Cards */}
                  {strikes.past_seasons.map((seasonGroup) => (
                    <div
                      key={seasonGroup.season}
                      className="rounded-2xl bg-space-900/65 border border-astral-700/35 overflow-hidden"
                    >
                      <div className="px-5 py-3 bg-space-800/70 border-b border-astral-700/30 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <History className="w-4 h-4 text-astral-300/70" />
                          <span className="font-display font-bold text-sm text-astral-100">
                            {seasonGroup.season}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-astral-800/60 border border-astral-600/30 text-[10px] font-semibold uppercase text-astral-300">
                            Past Season
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="text-xs text-astral-300/60 mr-2">Season Total:</span>
                          <span
                            className={`font-mono text-base font-bold ${strikeValueColor(
                              seasonGroup.total
                            )}`}
                          >
                            {seasonGroup.total}
                          </span>
                        </div>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-space-800/40 text-left text-xs text-astral-300/60">
                              <th className="px-4 py-2.5 font-medium">Value</th>
                              <th className="px-4 py-2.5 font-medium">Reason</th>
                              <th className="px-4 py-2.5 font-medium">Note</th>
                              <th className="px-4 py-2.5 font-medium">Clan</th>
                              <th className="px-4 py-2.5 font-medium">Issued Date</th>
                              <th className="px-4 py-2.5 font-medium">Confirmed By</th>
                            </tr>
                          </thead>
                          <tbody>
                            {seasonGroup.strikes.map((s) => (
                              <tr
                                key={s.id}
                                className="border-t border-astral-700/15 hover:bg-astral-700/10 transition"
                              >
                                <td className="px-4 py-2.5 font-mono font-bold">
                                  <span className={strikeValueColor(s.value)}>
                                    {s.value > 0 ? `+${s.value}` : s.value}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 text-astral-100">
                                  {s.reason || '—'}
                                </td>
                                <td className="px-4 py-2.5 text-astral-300/60">
                                  {s.note || '—'}
                                </td>
                                <td className="px-4 py-2.5 text-astral-200/80">
                                  {s.clan_name}
                                </td>
                                <td className="px-4 py-2.5 font-mono text-xs text-astral-300/80">
                                  {formatDate(s.issued_date)}
                                </td>
                                <td className="px-4 py-2.5 text-xs text-astral-300/60">
                                  {s.confirmed_by || '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </article>
      )}
    </main>
  );
}
