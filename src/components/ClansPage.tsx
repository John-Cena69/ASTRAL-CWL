import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  AlertCircle,
  AtSign,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Copy,
  ExternalLink,
  History,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  Sparkles,
  Trash2,
  Trophy,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import { compareClansByLeague } from '@/cwlLeague';

interface CwlClan {
  clan_tag: string;
  clan_name: string | null;
  cwl_league: string | null;
  leader_name?: string | null;
  badge_url: string | null;
}

interface Season {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  closed_by: string | null;
  closed_at: string | null;
}

interface SeasonClan {
  id: string;
  clan_tag: string;
  roster_size: number;
  role_id: string | null;
  added_by: string | null;
  added_at: string;
}

interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

interface EntrySummary {
  id: string;
  cwl_clan_tag: string | null;
}

interface RosterData {
  season: Season | null;
  past_seasons: Season[];
  clans: CwlClan[];
  season_clans: SeasonClan[];
  discord_roles?: DiscordRole[];
  entries: EntrySummary[];
  warning: string | null;
}

type ConfirmDialog =
  | { kind: 'update_clans'; adds: string[]; removes: string[]; affected: number }
  | { kind: 'new_season' }
  | { kind: 'close_season' }
  | { kind: 'rename_season' };

function normalizeTagInput(value: string): string {
  return `#${value.trim().toUpperCase().replace(/^#+/, '')}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function roleColorHex(color: number): string {
  return color > 0 ? `#${color.toString(16).padStart(6, '0')}` : '#99aab5';
}

function Modal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

// League badge files in /public: bronze1-3, silver1-3, ..., titan1-3, legend.
// In-game, League III shows 1 bar and League I shows 3, so the file number is
// the pip count, not the numeral (e.g. "Gold League I" -> gold3.webp).
const LEAGUE_PIPS: Record<string, number> = { i: 3, ii: 2, iii: 1 };

function leagueBadgeSrc(league: string | null): string | null {
  if (!league || league.trim().toLowerCase().includes('unrank')) return '/Unranked.webp';
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
    description: 'Publish and allow members to see roster.',
    enabledText: 'Roster is enabled',
    disabledText: 'Roster is disabled',
    ariaLabel: 'Toggle CWL roster',
    icon: Users,
  },
  {
    key: 'cwl_tracker_enabled',
    title: 'Tracker',
    description: 'Track status of signed up members and CWL clans.',
    enabledText: 'Tracker is enabled',
    disabledText: 'Tracker is disabled',
    ariaLabel: 'Toggle CWL tracker',
    icon: Activity,
  },
];

interface TableRolePickerProps {
  value: string | null;
  roles: DiscordRole[];
  usedByOtherClan: Map<string, string>;
  syncingRoles: boolean;
  saving: boolean;
  onSyncRoles: () => void;
  onChange: (roleId: string | null) => void;
}

function TableRolePicker({
  value,
  roles,
  usedByOtherClan,
  syncingRoles,
  saving,
  onSyncRoles,
  onChange,
}: TableRolePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [coords, setCoords] = useState<{ top: number; left: number; width: number; flipUp: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = roles.find((r) => r.id === value) ?? null;
  const hex = selected ? roleColorHex(selected.color) : value ? '#f59e0b' : '#99aab5';

  const updatePosition = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const menuWidth = Math.max(rect.width, 300);
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < 320 && rect.top > 320;
    const left = Math.max(12, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 12));
    setCoords({
      top: flipUp ? rect.top - 8 : rect.bottom + 8,
      left,
      width: menuWidth,
      flipUp,
    });
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        menuRef.current &&
        !menuRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const handleScrollOrResize = () => updatePosition();
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const visible = roles.filter((r) => !q || r.name.toLowerCase().includes(q) || r.id.includes(q));

  return (
    <div className="inline-flex items-center justify-end gap-1.5 w-full sm:w-auto">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((cur) => !cur)}
        className={`group/picker relative inline-flex items-center gap-2.5 rounded-xl border px-3.5 py-2 text-xs transition-all duration-150 min-w-[13.5rem] max-w-[18rem] justify-between ${
          selected || value
            ? 'bg-space-900/80 border-astral-600/50 hover:border-gold-400/50 text-white shadow-sm'
            : 'bg-space-900/40 border-dashed border-astral-700/50 hover:border-astral-500/60 hover:bg-space-800/70 text-astral-300/70'
        }`}
        style={
          selected && selected.color > 0
            ? {
                borderColor: `${hex}55`,
                backgroundColor: `${hex}14`,
              }
            : undefined
        }
        title={
          selected
            ? `Discord role: @${selected.name} (ID: ${selected.id})`
            : value
              ? `Discord role ID: ${value}`
              : 'Assign a Discord role to this CWL clan'
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0 transition-transform group-hover/picker:scale-110"
            style={{
              backgroundColor: selected || value ? hex : 'rgba(153,170,181,0.35)',
              boxShadow: selected && selected.color > 0 ? `0 0 8px ${hex}88` : undefined,
            }}
          />
          <span className={`truncate ${selected || value ? 'font-semibold text-white' : 'text-astral-300/60'}`}>
            {selected ? `@${selected.name}` : value ? `Role ${value}` : 'Select Discord role...'}
          </span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {saving ? (
            <LoaderCircle className="w-3.5 h-3.5 animate-spin text-gold-300" />
          ) : (
            <ChevronDown
              className={`w-3.5 h-3.5 text-astral-300/60 transition-transform duration-150 ${
                open ? 'rotate-180 text-gold-300' : ''
              }`}
            />
          )}
        </span>
      </button>

      {value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={saving}
          className="p-2 rounded-xl border border-astral-700/30 bg-space-900/50 text-astral-300/50 hover:text-rose-300 hover:border-rose-500/30 hover:bg-rose-500/10 transition shrink-0"
          title="Clear mapped Discord role"
          aria-label="Clear mapped Discord role"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}

      {open &&
        coords &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              width: coords.width,
              transform: coords.flipUp ? 'translateY(-100%)' : undefined,
            }}
            className="z-50 rounded-2xl border border-astral-600/40 bg-space-800/95 backdrop-blur-xl p-2.5 shadow-2xl shadow-space-950 ring-1 ring-white/5"
          >
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-astral-300/50" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search Discord roles..."
                  className="astral-input w-full pl-8 pr-7 py-1.5 text-xs"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-astral-300/50 hover:text-white"
                    aria-label="Clear search"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={onSyncRoles}
                disabled={syncingRoles}
                className="p-2 rounded-xl border border-astral-700/40 bg-space-900/60 text-astral-300/80 hover:text-white hover:border-gold-400/40 shrink-0 transition"
                title="Sync roles from Discord server"
                aria-label="Sync roles from Discord server"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncingRoles ? 'animate-spin text-gold-300' : ''}`} />
              </button>
            </div>

            <ul
              role="listbox"
              className="mt-2 max-h-64 overflow-y-auto overscroll-contain space-y-0.5 text-xs pr-0.5"
            >
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={!value}
                  onClick={() => {
                    onChange(null);
                    setOpen(false);
                    setQuery('');
                  }}
                  className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${
                    !value
                      ? 'bg-white/5 text-white font-medium'
                      : 'text-astral-300/70 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <X className="w-3.5 h-3.5 shrink-0 text-rose-300/70" />
                  <span className="flex-1">No Discord role (Unmapped)</span>
                  {!value && <Check className="w-3.5 h-3.5 text-gold-300 shrink-0" />}
                </button>
              </li>

              {visible.length === 0 ? (
                <li className="px-3 py-5 text-center text-astral-300/50">
                  {roles.length === 0
                    ? 'No roles synced yet — click the refresh button.'
                    : 'No matching Discord roles.'}
                </li>
              ) : (
                visible.map((role) => {
                  const isSelected = role.id === value;
                  const otherClan = usedByOtherClan.get(role.id);
                  const roleHex = roleColorHex(role.color);
                  return (
                    <li key={role.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          onChange(role.id);
                          setOpen(false);
                          setQuery('');
                        }}
                        className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${
                          isSelected
                            ? 'bg-gold-500/15 border border-gold-400/30 text-white'
                            : 'border border-transparent hover:bg-white/5 text-astral-100'
                        }`}
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{
                            backgroundColor: roleHex,
                            boxShadow: role.color > 0 ? `0 0 6px ${roleHex}80` : undefined,
                          }}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate font-medium">@{role.name}</span>
                          {otherClan && (
                            <span className="block truncate text-[10px] text-amber-300/80">
                              Also mapped to {otherClan}
                            </span>
                          )}
                        </span>
                        {isSelected && <Check className="w-3.5 h-3.5 text-gold-300 shrink-0" />}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>,
          document.body
        )}
    </div>
  );
}

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

  // ─── Season, Season Clans & Discord Role Mapping State ───
  const [rosterData, setRosterData] = useState<RosterData | null>(null);
  const [seasonLoading, setSeasonLoading] = useState(true);
  const [seasonBusy, setSeasonBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmDialog | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [clearAssignments, setClearAssignments] = useState(true);
  const [clansCollapsed, setClansCollapsed] = useState(false);
  const [showPastSeasons, setShowPastSeasons] = useState(false);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [syncingRoles, setSyncingRoles] = useState(false);
  const [savingRoles, setSavingRoles] = useState<Set<string>>(() => new Set());
  const [roleSearch, setRoleSearch] = useState('');
  const pendingRoleOps = useRef(0);

  const rosterRequest = async (method: 'GET' | 'POST', payload?: Record<string, unknown>) => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const response = await fetch('/api/cwl-roster', {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
      ok?: boolean;
      error?: string;
    };
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };

  const loadSeasonData = async (silent = false) => {
    if (!silent) setSeasonLoading(true);
    try {
      const body = (await rosterRequest('GET')) as unknown as RosterData;
      setRosterData(body);
      if (body.warning && !silent) setMessage(body.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load CWL season data.');
    } finally {
      setSeasonLoading(false);
    }
  };

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
    void loadSeasonData();
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

  const seasonAct = async (payload: Record<string, unknown>, successMsg?: string): Promise<boolean> => {
    setSeasonBusy(true);
    setError(null);
    try {
      await rosterRequest('POST', payload);
      if (successMsg) setMessage(successMsg);
      await loadSeasonData(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
      await loadSeasonData(true);
      return false;
    } finally {
      setSeasonBusy(false);
    }
  };

  const syncDiscordRoles = async () => {
    setSyncingRoles(true);
    setError(null);
    try {
      const body = await rosterRequest('POST', { action: 'sync_roles' });
      const roles = Array.isArray(body.discord_roles) ? (body.discord_roles as DiscordRole[]) : [];
      setRosterData((prev) => (prev ? { ...prev, discord_roles: roles } : prev));
      setMessage(`Synced ${roles.length} Discord role(s) from server.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync Discord roles.');
    } finally {
      setSyncingRoles(false);
    }
  };

  const markRoleSaving = (tag: string, on: boolean) => {
    setSavingRoles((current) => {
      const next = new Set(current);
      if (on) next.add(tag);
      else next.delete(tag);
      return next;
    });
  };

  const setClanRole = (clanTag: string, roleId: string | null) => {
    setError(null);
    setRosterData((prev) =>
      prev
        ? {
            ...prev,
            season_clans: prev.season_clans.map((sc) =>
              sc.clan_tag === clanTag ? { ...sc, role_id: roleId } : sc
            ),
          }
        : prev
    );
    pendingRoleOps.current += 1;
    markRoleSaving(clanTag, true);
    void (async () => {
      try {
        await rosterRequest('POST', { action: 'set_role', clan_tag: clanTag, role_id: roleId });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save Discord role mapping.');
      } finally {
        pendingRoleOps.current -= 1;
        markRoleSaving(clanTag, false);
        if (pendingRoleOps.current === 0) void loadSeasonData(true);
      }
    })();
  };

  const clanByTag = useMemo(() => {
    const map = new Map<string, CwlClan>();
    for (const c of rosterData?.clans ?? []) map.set(c.clan_tag, c);
    for (const c of clans) map.set(c.clan_tag, c);
    return map;
  }, [rosterData, clans]);

  const sortedClans = useMemo(() => {
    const source = clans.length > 0 ? clans : rosterData?.clans ?? [];
    return [...source].sort(compareClansByLeague);
  }, [clans, rosterData]);

  const sortedSeasonClans = useMemo(() => {
    return [...(rosterData?.season_clans ?? [])].sort((a, b) => {
      const ca = clanByTag.get(a.clan_tag) ?? { cwl_league: null, clan_name: a.clan_tag };
      const cb = clanByTag.get(b.clan_tag) ?? { cwl_league: null, clan_name: b.clan_tag };
      return compareClansByLeague(ca, cb);
    });
  }, [rosterData, clanByTag]);

  const seasonTags = useMemo(
    () => new Set((rosterData?.season_clans ?? []).map((sc) => sc.clan_tag)),
    [rosterData]
  );

  const effectiveDraft = draft ?? seasonTags;
  const draftAdds = sortedClans
    .map((c) => c.clan_tag)
    .filter((tag) => effectiveDraft.has(tag) && !seasonTags.has(tag));
  const draftRemoves = [...seasonTags].filter((tag) => !effectiveDraft.has(tag));

  const toggleDraft = (tag: string) => {
    setDraft((current) => {
      const next = new Set(current ?? seasonTags);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const applyClanChanges = async () => {
    setError(null);
    setMessage(null);
    if (draftRemoves.length > 0) {
      const affected = (rosterData?.entries ?? []).filter(
        (entry) => entry.cwl_clan_tag && draftRemoves.includes(entry.cwl_clan_tag)
      ).length;
      setConfirm({ kind: 'update_clans', adds: draftAdds, removes: draftRemoves, affected });
      return;
    }
    if (
      await seasonAct(
        { action: 'update_clans', add: draftAdds, remove: [] },
        `${draftAdds.length} clan(s) added to the season.`
      )
    ) {
      setDraft(null);
    }
  };

  const openSeasonDialog = (kind: 'new_season' | 'close_season' | 'rename_season') => {
    setNameInput(kind === 'rename_season' ? rosterData?.season?.name ?? '' : '');
    setClearAssignments(true);
    setConfirm({ kind });
    setError(null);
    setMessage(null);
  };

  const runConfirm = async () => {
    if (!confirm) return;
    let ok = false;
    if (confirm.kind === 'update_clans') {
      ok = await seasonAct(
        { action: 'update_clans', add: confirm.adds, remove: confirm.removes },
        'Season clans updated.'
      );
      if (ok) setDraft(null);
    } else if (confirm.kind === 'new_season') {
      ok = await seasonAct(
        { action: 'create_season', name: nameInput, clear_assignments: clearAssignments },
        'New season started.'
      );
    } else if (confirm.kind === 'close_season') {
      ok = await seasonAct(
        { action: 'close_season', clear_assignments: clearAssignments },
        'Season closed.'
      );
    } else if (confirm.kind === 'rename_season') {
      ok = await seasonAct({ action: 'rename_season', name: nameInput }, 'Season renamed.');
    }
    if (ok) {
      setConfirm(null);
      if (confirm.kind === 'new_season' || confirm.kind === 'close_season') setDraft(null);
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
      await Promise.all([loadClans(), loadSeasonData(true)]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Add failed.';
      setError(
        msg.includes('Failed to fetch') || msg.includes('Load failed')
          ? `${msg} (Adding needs the deployed site or "npx vercel dev" — plain "npm run dev" has no /api.)`
          : msg
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
      await Promise.all([loadClans(), loadSeasonData(true)]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Refresh failed.';
      setError(
        msg.includes('Failed to fetch') || msg.includes('Load failed')
          ? `${msg} (Refresh needs the deployed site or "npx vercel dev" — plain "npm run dev" has no /api.)`
          : msg
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
      await loadSeasonData(true);
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
  const season = rosterData?.season ?? null;
  const discordRoles = rosterData?.discord_roles ?? [];
  const mappedRolesCount = sortedSeasonClans.filter((sc) => Boolean(sc.role_id)).length;

  const roleUsageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sc of sortedSeasonClans) {
      if (sc.role_id) counts.set(sc.role_id, (counts.get(sc.role_id) ?? 0) + 1);
    }
    return counts;
  }, [sortedSeasonClans]);

  const filteredSeasonClansForTable = useMemo(() => {
    const q = roleSearch.trim().toLowerCase().replace(/^[@#]/, '');
    if (!q) return sortedSeasonClans;
    return sortedSeasonClans.filter((sc) => {
      const clan = clanByTag.get(sc.clan_tag);
      const role = discordRoles.find((r) => r.id === sc.role_id);
      const nameMatch = (clan?.clan_name ?? '').toLowerCase().includes(q);
      const tagMatch = sc.clan_tag.toLowerCase().replace(/^#/, '').includes(q);
      const leagueMatch = (clan?.cwl_league ?? 'unranked').toLowerCase().includes(q);
      const roleMatch = (role?.name ?? '').toLowerCase().includes(q);
      return nameMatch || tagMatch || leagueMatch || roleMatch;
    });
  }, [sortedSeasonClans, roleSearch, clanByTag, discordRoles]);

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-24 space-y-8">
      {/* ─── Page Header: CWL Dashboard ─── */}
      <header className="relative overflow-hidden rounded-2xl border border-astral-700/30 bg-gradient-to-br from-space-800/90 via-space-800/60 to-astral-950/40 p-6 sm:p-7 backdrop-blur-md shadow-xl shadow-space-950/50">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gold-400/5 blur-3xl" />
        <div className="pointer-events-none absolute -left-16 -bottom-16 h-48 w-48 rounded-full bg-astral-500/10 blur-3xl" />

        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start sm:items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-gold-400/20 to-astral-600/30 border border-gold-400/30 flex items-center justify-center shrink-0 shadow-lg shadow-astral-950/60">
              <img src="/cwlmedal.webp" alt="CWL Medal" className="w-8 h-8 object-contain drop-shadow" />
            </div>
            <div>
              <h2 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
                CWL Dashboard
              </h2>
              <p className="mt-1 text-sm text-astral-200/70">
                Control CWL workflow, manage active seasons &amp; Discord role mappings, and configure CWL clans.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 self-start sm:self-center">
            {!seasonLoading && (
              <div
                className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-medium ${
                  season
                    ? 'border-gold-400/30 bg-gold-500/10 text-gold-200'
                    : 'border-astral-700/40 bg-space-900/60 text-astral-300/70'
                }`}
              >
                <Calendar className="w-3.5 h-3.5 text-gold-300" />
                <span>{season ? season.name : 'No active season'}</span>
              </div>
            )}
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
                Configure CWL Settings through toggle switches.
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

      {/* ─── Section 2: CWL Season, Clans for This Season & Discord Role Mapping ─── */}
      <section aria-labelledby="cwl-season-heading" className="space-y-6">
        {/* Season section header + actions */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gold-500/15 border border-gold-400/30 flex items-center justify-center text-gold-300">
              <Calendar className="w-4 h-4" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 id="cwl-season-heading" className="font-display text-lg font-bold text-white">
                  CWL Season &amp; Role Mapping
                </h3>
                {season && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
                    Active Season
                  </span>
                )}
              </div>
              <p className="text-xs text-astral-300/60">
                Manage the current CWL season, select participating clans, and map each clan to its Discord role.
              </p>
            </div>
          </div>

          {season && (
            <div className="flex flex-wrap items-center gap-2">
              {(rosterData?.past_seasons.length ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => setShowPastSeasons((cur) => !cur)}
                  className={`astral-btn-ghost text-xs ${showPastSeasons ? 'border-gold-400/40 text-gold-200 bg-gold-500/10' : ''}`}
                  title="View past closed seasons"
                >
                  <History className="w-3.5 h-3.5" />
                  Past seasons ({rosterData?.past_seasons.length})
                </button>
              )}
              <button
                type="button"
                onClick={() => openSeasonDialog('rename_season')}
                className="astral-btn-ghost text-xs"
                title="Rename active season"
              >
                <Pencil className="w-3.5 h-3.5" /> Rename
              </button>
              <button
                type="button"
                onClick={() => openSeasonDialog('new_season')}
                className="astral-btn-ghost text-xs text-gold-200 border-gold-400/30 hover:bg-gold-500/10"
              >
                <Plus className="w-3.5 h-3.5" /> New season
              </button>
              <button
                type="button"
                onClick={() => openSeasonDialog('close_season')}
                className="astral-btn-ghost text-xs text-rose-200 hover:border-rose-500/40 hover:bg-rose-500/10"
              >
                <X className="w-3.5 h-3.5" /> Close season
              </button>
            </div>
          )}
        </div>

        {seasonLoading ? (
          <div className="astral-card p-12 text-center text-astral-300/60">
            <LoaderCircle className="w-6 h-6 animate-spin mx-auto text-gold-300" />
            <p className="mt-3 text-sm">Loading CWL season configuration...</p>
          </div>
        ) : !season ? (
          <div className="astral-card relative overflow-hidden p-10 text-center border-gold-400/20 bg-gradient-to-br from-space-800/90 via-space-800/70 to-astral-950/30">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-gold-500/10 border border-gold-400/30 flex items-center justify-center">
              <Calendar className="w-7 h-7 text-gold-300" />
            </div>
            <h4 className="mt-4 font-display text-lg font-bold text-white">No active CWL season</h4>
            <p className="mt-1.5 text-sm text-astral-300/60 max-w-md mx-auto">
              Start a new CWL season to select participating clans, configure Discord role mappings, and build rosters.
            </p>
            <button
              type="button"
              onClick={() => openSeasonDialog('new_season')}
              className="astral-btn-primary mt-5"
            >
              <Plus className="w-4 h-4" /> Start a season
            </button>
            {(rosterData?.past_seasons.length ?? 0) > 0 && (
              <p className="mt-4 text-xs text-astral-300/50">
                Last season: <span className="text-astral-200 font-medium">{rosterData?.past_seasons[0].name}</span>{' '}
                (closed {formatDate(rosterData?.past_seasons[0].closed_at ?? null)})
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Active Season Summary Banner */}
            <div className="relative overflow-hidden rounded-2xl border border-gold-400/25 bg-gradient-to-r from-gold-500/[0.08] via-space-800/85 to-space-800/85 p-5 shadow-lg">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-gold-500/15 border border-gold-400/35 flex items-center justify-center text-gold-300 shrink-0">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2.5">
                      <span className="font-display text-xl font-bold text-white">{season.name}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-astral-300/70">
                      Started by <span className="text-astral-100 font-medium">{season.created_by ?? 'unknown'}</span> on{' '}
                      {formatDate(season.created_at)}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 text-xs">
                  <div className="rounded-xl border border-astral-700/40 bg-space-900/60 px-3 py-1.5 text-astral-200">
                    <span className="text-astral-300/60">Season clans:</span>{' '}
                    <span className="font-semibold text-white tabular-nums">
                      {seasonTags.size}/{sortedClans.length}
                    </span>
                  </div>
                  <div
                    className={`rounded-xl border px-3 py-1.5 ${
                      sortedSeasonClans.length > 0 && mappedRolesCount === sortedSeasonClans.length
                        ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                        : 'border-astral-700/40 bg-space-900/60 text-astral-200'
                    }`}
                  >
                    <span className="opacity-70">Roles mapped:</span>{' '}
                    <span className="font-semibold tabular-nums">
                      {mappedRolesCount}/{sortedSeasonClans.length}
                    </span>
                  </div>
                </div>
              </div>

              {showPastSeasons && (rosterData?.past_seasons.length ?? 0) > 0 && (
                <div className="mt-4 pt-4 border-t border-astral-700/30">
                  <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-astral-300/70">
                    <History className="w-3.5 h-3.5" /> Past Seasons
                  </h4>
                  <ul className="mt-2.5 grid gap-2 sm:grid-cols-2 text-xs">
                    {rosterData?.past_seasons.map((past) => (
                      <li
                        key={past.id}
                        className="flex items-center justify-between gap-2 rounded-xl border border-astral-700/25 bg-space-900/50 px-3 py-2"
                      >
                        <span className="font-medium text-white truncate">{past.name}</span>
                        <span className="text-astral-300/60 shrink-0">
                          Closed by {past.closed_by ?? 'unknown'} · {formatDate(past.closed_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* ─── Sub-card A: Clans for This Season ─── */}
            <div className="astral-card overflow-hidden">
              <div className="p-5 flex items-center justify-between gap-4 border-b border-astral-700/20">
                <div>
                  <div className="flex items-center gap-2.5">
                    <h4 className="font-display text-base font-bold text-white">
                      Clans for this season
                    </h4>
                    <span className="rounded-full border border-gold-400/30 bg-gold-500/10 px-2.5 py-0.5 text-xs font-semibold text-gold-300 tabular-nums">
                      {seasonTags.size}/{sortedClans.length} selected
                    </span>
                  </div>
                  {!clansCollapsed && (
                    <p className="mt-1 text-xs text-astral-300/60">
                      Tick the clans participating in <span className="text-astral-100 font-medium">{season.name}</span>, then apply all changes at once.
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {!clansCollapsed && sortedClans.length > 0 && (
                    <div className="hidden sm:flex items-center gap-2.5 text-xs">
                      <button
                        type="button"
                        disabled={seasonBusy}
                        onClick={() => setDraft(new Set(sortedClans.map((clan) => clan.clan_tag)))}
                        className="text-astral-300/70 hover:text-white underline underline-offset-2"
                      >
                        Select all
                      </button>
                      <span className="text-astral-300/30">·</span>
                      <button
                        type="button"
                        disabled={seasonBusy}
                        onClick={() => setDraft(new Set())}
                        className="text-astral-300/70 hover:text-white underline underline-offset-2"
                      >
                        Select none
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setClansCollapsed((current) => !current)}
                    className="p-2 text-astral-300/70 hover:text-white hover:bg-white/5 rounded-lg"
                    title={clansCollapsed ? 'Expand clans list' : 'Minimise clans list'}
                    aria-label={clansCollapsed ? 'Expand clans list' : 'Minimise clans list'}
                    aria-expanded={!clansCollapsed}
                  >
                    {clansCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {!clansCollapsed && (
                <div className="p-5">
                  {sortedClans.length === 0 ? (
                    <p className="text-sm text-astral-300/50">
                      No CWL clans in the directory yet. Add some in the CWL Clans section below.
                    </p>
                  ) : (
                    <>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {sortedClans.map((clan) => {
                          const selected = effectiveDraft.has(clan.clan_tag);
                          const saved = seasonTags.has(clan.clan_tag);
                          const sc = rosterData?.season_clans.find((item) => item.clan_tag === clan.clan_tag);
                          const state = selected && !saved ? 'adding' : !selected && saved ? 'removing' : null;
                          const badgeSrc = leagueBadgeSrc(clan.cwl_league);

                          return (
                            <button
                              key={clan.clan_tag}
                              type="button"
                              disabled={seasonBusy}
                              onClick={() => toggleDraft(clan.clan_tag)}
                              className={`group flex items-center gap-3 rounded-xl border p-3.5 text-left transition-all duration-150 disabled:opacity-60 ${
                                selected
                                  ? 'border-gold-400/50 bg-gradient-to-br from-gold-500/15 via-gold-500/5 to-transparent shadow-md shadow-space-950/50'
                                  : 'border-astral-700/30 bg-space-900/35 hover:border-astral-600/50 hover:bg-white/5'
                              }`}
                              title={
                                sc
                                  ? `Added by ${sc.added_by ?? 'unknown'} on ${formatDate(sc.added_at)}`
                                  : 'Select for this season'
                              }
                            >
                              <span
                                className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition ${
                                  selected
                                    ? 'border-gold-400 bg-gold-400 text-space-950'
                                    : 'border-astral-300/40 group-hover:border-astral-300/70'
                                }`}
                              >
                                {selected && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                              </span>
                              {clan.badge_url ? (
                                <img src={clan.badge_url} alt="" className="w-10 h-10 object-contain shrink-0" />
                              ) : (
                                <Shield className="w-8 h-8 text-astral-300/50 shrink-0" />
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-semibold text-white">
                                  {clan.clan_name ?? clan.clan_tag}
                                </span>
                                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-astral-300/60 truncate">
                                  {badgeSrc && <img src={badgeSrc} alt="" className="w-3.5 h-3.5 object-contain shrink-0" />}
                                  <span className="truncate">{clan.cwl_league ?? 'Unranked'}</span>
                                </span>
                              </span>
                              {state && (
                                <span
                                  className={`text-[10px] font-semibold uppercase rounded-full px-2 py-0.5 shrink-0 ${
                                    state === 'adding'
                                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                      : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                                  }`}
                                >
                                  {state === 'adding' ? 'Adding' : 'Removing'}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-4 pt-4 border-t border-astral-700/20 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={seasonBusy || draftAdds.length + draftRemoves.length === 0}
                            onClick={() => void applyClanChanges()}
                            className="astral-btn-primary text-xs disabled:opacity-50"
                          >
                            {seasonBusy ? (
                              <LoaderCircle className="w-4 h-4 animate-spin" />
                            ) : (
                              <Check className="w-4 h-4" />
                            )}
                            Apply changes
                            {draftAdds.length + draftRemoves.length > 0
                              ? ` (+${draftAdds.length} / −${draftRemoves.length})`
                              : ''}
                          </button>
                          <button
                            type="button"
                            disabled={seasonBusy || draftAdds.length + draftRemoves.length === 0}
                            onClick={() => setDraft(null)}
                            className="astral-btn-ghost text-xs disabled:opacity-40"
                          >
                            Reset
                          </button>
                        </div>

                        <div className="flex sm:hidden items-center gap-3 text-xs">
                          <button
                            type="button"
                            disabled={seasonBusy}
                            onClick={() => setDraft(new Set(sortedClans.map((clan) => clan.clan_tag)))}
                            className="text-astral-300/70 hover:text-white underline underline-offset-2"
                          >
                            Select all
                          </button>
                          <button
                            type="button"
                            disabled={seasonBusy}
                            onClick={() => setDraft(new Set())}
                            className="text-astral-300/70 hover:text-white underline underline-offset-2"
                          >
                            Select none
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* ─── Sub-card B: CWL Clan Name to Discord Role Mapping Table ─── */}
            <div className="astral-card overflow-hidden">
              <div className="p-5 border-b border-astral-700/25 bg-gradient-to-r from-space-800/90 via-space-800/60 to-astral-950/30">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div className="flex items-start sm:items-center gap-3.5">
                    <div className="w-10 h-10 rounded-xl bg-astral-600/20 border border-astral-500/35 flex items-center justify-center text-gold-300 shrink-0">
                      <AtSign className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h4 className="font-display text-base sm:text-lg font-bold text-white">
                          CWL Clan to Discord Role Mapping
                        </h4>
                        {sortedSeasonClans.length > 0 && (
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold tabular-nums ${
                              mappedRolesCount === sortedSeasonClans.length
                                ? 'border-emerald-400/35 bg-emerald-500/15 text-emerald-300'
                                : 'border-gold-400/30 bg-gold-500/10 text-gold-300'
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                mappedRolesCount === sortedSeasonClans.length
                                  ? 'bg-emerald-400'
                                  : 'bg-gold-400'
                              }`}
                            />
                            {mappedRolesCount}/{sortedSeasonClans.length} mapped
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-astral-300/60">
                        Link each active season CWL clan to its Discord server role. Changes save automatically.
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    {sortedSeasonClans.length > 0 && (
                      <div className="relative flex-1 sm:flex-initial sm:w-60">
                        <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-astral-300/50" />
                        <input
                          value={roleSearch}
                          onChange={(e) => setRoleSearch(e.target.value)}
                          placeholder="Filter clan or role..."
                          className="astral-input w-full pl-8 pr-7 py-1.5 text-xs"
                        />
                        {roleSearch && (
                          <button
                            type="button"
                            onClick={() => setRoleSearch('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-astral-300/50 hover:text-white"
                            aria-label="Clear filter"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => void syncDiscordRoles()}
                      disabled={syncingRoles}
                      className="astral-btn-ghost text-xs"
                      title="Sync roles from Discord server"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${syncingRoles ? 'animate-spin text-gold-300' : ''}`} />
                      <span>{syncingRoles ? 'Syncing roles...' : 'Sync Discord roles'}</span>
                      {discordRoles.length > 0 && (
                        <span className="ml-0.5 rounded-full bg-white/10 px-1.5 py-0.2 text-[10px] text-astral-200 tabular-nums">
                          {discordRoles.length}
                        </span>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {sortedSeasonClans.length === 0 ? (
                <div className="p-10 text-center">
                  <AtSign className="w-8 h-8 mx-auto text-astral-300/30" />
                  <p className="mt-3 text-sm font-medium text-astral-100">
                    No clans selected for {season.name} yet
                  </p>
                  <p className="mt-1 text-xs text-astral-300/60">
                    Select and apply at least one clan in <span className="text-gold-300 font-medium">Clans for this season</span> above to configure Discord role mappings.
                  </p>
                </div>
              ) : filteredSeasonClansForTable.length === 0 ? (
                <div className="p-10 text-center">
                  <Search className="w-7 h-7 mx-auto text-astral-300/30" />
                  <p className="mt-2.5 text-sm text-astral-300/60">
                    No season clans or Discord roles match &ldquo;{roleSearch.trim()}&rdquo;.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-astral-700/25 bg-space-900/50 text-[11px] font-semibold uppercase tracking-wider text-astral-300/60">
                        <th className="px-4 py-3.5 text-left w-12">#</th>
                        <th className="px-4 py-3.5 text-left">CWL Clan Name</th>
                        <th className="px-4 py-3.5 text-left">CWL League</th>
                        <th className="px-4 py-3.5 text-center">Format</th>
                        <th className="px-4 py-3.5 text-left">Status</th>
                        <th className="px-5 py-3.5 text-right">Discord Role</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-astral-700/15">
                      {filteredSeasonClansForTable.map((sc, idx) => {
                        const clan = clanByTag.get(sc.clan_tag);
                        const clanLabel = clan?.clan_name ?? sc.clan_tag;
                        const leagueLabel = clan?.cwl_league ?? 'Unranked';
                        const badgeSrc = leagueBadgeSrc(clan?.cwl_league ?? null);
                        const isCopied = copiedTag === sc.clan_tag;
                        const isSavingRole = savingRoles.has(sc.clan_tag);
                        const isDuplicateRole =
                          Boolean(sc.role_id) && (roleUsageCounts.get(sc.role_id!) ?? 0) > 1;

                        const usedByOtherClan = new Map<string, string>();
                        for (const other of sortedSeasonClans) {
                          if (other.clan_tag !== sc.clan_tag && other.role_id) {
                            usedByOtherClan.set(
                              other.role_id,
                              clanByTag.get(other.clan_tag)?.clan_name ?? other.clan_tag
                            );
                          }
                        }

                        return (
                          <tr
                            key={sc.id}
                            className="group transition-colors hover:bg-astral-700/[0.08]"
                          >
                            {/* # */}
                            <td className="px-4 py-3.5 font-mono text-xs text-astral-300/50 tabular-nums">
                              {String(idx + 1).padStart(2, '0')}
                            </td>

                            {/* CWL Clan Name */}
                            <td className="px-4 py-3.5">
                              <div className="flex items-center gap-3 min-w-[12rem]">
                                {clan?.badge_url ? (
                                  <img
                                    src={clan.badge_url}
                                    alt=""
                                    className="w-10 h-10 object-contain shrink-0 drop-shadow"
                                  />
                                ) : (
                                  <div className="w-10 h-10 rounded-xl bg-astral-700/30 border border-astral-700/40 flex items-center justify-center shrink-0">
                                    <Shield className="w-5 h-5 text-gold-300" />
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <div className="font-semibold text-white truncate">{clanLabel}</div>
                                  <button
                                    type="button"
                                    onClick={() => void copyClanTag(sc.clan_tag)}
                                    className="inline-flex items-center gap-1 text-xs font-mono text-gold-400/80 hover:text-gold-300 transition"
                                    title="Click to copy clan tag"
                                  >
                                    <span>{sc.clan_tag}</span>
                                    {isCopied ? (
                                      <Check className="w-3 h-3 text-emerald-400" />
                                    ) : (
                                      <Copy className="w-2.5 h-2.5 opacity-50 group-hover:opacity-100 transition-opacity" />
                                    )}
                                  </button>
                                </div>
                              </div>
                            </td>

                            {/* CWL League */}
                            <td className="px-4 py-3.5 whitespace-nowrap">
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-gold-400/25 bg-gold-500/10 px-2.5 py-1 text-xs font-medium text-gold-200">
                                {badgeSrc ? (
                                  <img src={badgeSrc} alt="" className="w-4 h-4 object-contain" />
                                ) : (
                                  <Trophy className="w-3.5 h-3.5 text-gold-300" />
                                )}
                                {leagueLabel}
                              </span>
                            </td>

                            {/* Roster Format */}
                            <td className="px-4 py-3.5 text-center whitespace-nowrap">
                              <span className="inline-flex items-center rounded-lg border border-astral-700/40 bg-space-900/60 px-2.5 py-1 text-xs font-semibold text-astral-200 tabular-nums">
                                {sc.roster_size}v{sc.roster_size}
                              </span>
                            </td>

                            {/* Status */}
                            <td className="px-4 py-3.5 whitespace-nowrap">
                              {isDuplicateRole ? (
                                <span
                                  className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/35 bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-200"
                                  title="This Discord role is assigned to multiple CWL clans"
                                >
                                  <AlertCircle className="w-3.5 h-3.5 text-amber-300" />
                                  Shared Role
                                </span>
                              ) : sc.role_id ? (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
                                  Mapped
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-astral-700/40 bg-space-900/50 px-2.5 py-1 text-xs font-medium text-astral-300/50">
                                  <span className="h-1.5 w-1.5 rounded-full bg-astral-400/40" />
                                  Unmapped
                                </span>
                              )}
                            </td>

                            {/* Discord Role Picker */}
                            <td className="px-5 py-3.5 text-right">
                              <TableRolePicker
                                value={sc.role_id ?? null}
                                roles={discordRoles}
                                usedByOtherClan={usedByOtherClan}
                                syncingRoles={syncingRoles}
                                saving={isSavingRole}
                                onSyncRoles={() => void syncDiscordRoles()}
                                onChange={(roleId) => setClanRole(sc.clan_tag, roleId)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="gold-divider opacity-40" />

      {/* ─── Section 3: CWL Clans ─── */}
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
                View and manage CWL Clans.
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
                      <h4 className="font-body text-lg font-bold text-white tracking-tight truncate">
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
                      <img src="/clan_owner.png" alt="" className="w-4 h-4 object-contain shrink-0" />
                      <span className="text-astral-300/60 text-xs uppercase tracking-wide">
                        Leader
                      </span>
                      <span className="ml-auto font-medium text-white truncate">
                        {clan.leader_name ?? '—'}
                      </span>
                    </div>
                    <div className="px-5 py-2.5 flex items-center gap-2 text-sm text-astral-200">
                      <Link2 className="w-4 h-4 text-astral-300/70 shrink-0" />
                      <span className="text-astral-300/60 text-xs uppercase tracking-wide">
                        In-game link
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

      {/* ─── Season / Clan Update Confirm Modals ─── */}
      {confirm && (
        <Modal>
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm season action"
          >
            <div
              className="absolute inset-0 bg-space-950/70 backdrop-blur-sm"
              onClick={() => !seasonBusy && setConfirm(null)}
              aria-hidden="true"
            />
            <div className="relative bg-space-800 border border-astral-700/30 rounded-2xl p-6 w-full max-w-md shadow-2xl shadow-space-950">
              {confirm.kind === 'update_clans' && (
                <>
                  <h3 className="font-display text-lg font-bold text-white">Apply clan changes?</h3>
                  <p className="mt-2 text-sm text-astral-200/70">
                    {confirm.adds.length > 0 && (
                      <>
                        Adding{' '}
                        <span className="font-semibold text-white">
                          {confirm.adds.map((tag) => clanByTag.get(tag)?.clan_name ?? tag).join(', ')}
                        </span>
                        .{' '}
                      </>
                    )}
                    Removing{' '}
                    <span className="font-semibold text-white">
                      {confirm.removes.map((tag) => clanByTag.get(tag)?.clan_name ?? tag).join(', ')}
                    </span>
                    {confirm.affected > 0
                      ? `; ${confirm.affected} assigned player(s) will be unassigned (their CWL entries are kept).`
                      : '.'}
                  </p>
                </>
              )}
              {(confirm.kind === 'new_season' || confirm.kind === 'rename_season') && (
                <>
                  <h3 className="font-display text-lg font-bold text-white">
                    {confirm.kind === 'new_season' ? 'Start a new season' : 'Rename season'}
                  </h3>
                  {confirm.kind === 'new_season' && season && (
                    <p className="mt-2 text-sm text-astral-200/70">
                      This closes <span className="font-semibold text-white">{season.name}</span> and starts a fresh season with no clans selected.
                    </p>
                  )}
                  <label className="mt-4 block text-sm text-astral-200">
                    Season name
                    <input
                      autoFocus
                      maxLength={60}
                      value={nameInput}
                      onChange={(event) => setNameInput(event.target.value)}
                      placeholder="e.g. November 2026"
                      className="astral-input mt-1.5 w-full"
                    />
                  </label>
                </>
              )}
              {confirm.kind === 'close_season' && (
                <>
                  <h3 className="font-display text-lg font-bold text-white">Close season?</h3>
                  <p className="mt-2 text-sm text-astral-200/70">
                    <span className="font-semibold text-white">{season?.name}</span> will be closed. You can start a new season afterwards.
                  </p>
                </>
              )}
              {(confirm.kind === 'new_season' || confirm.kind === 'close_season') && (
                <label className="mt-4 flex items-start gap-2.5 text-sm text-astral-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={clearAssignments}
                    onChange={(event) => setClearAssignments(event.target.checked)}
                    className="mt-0.5"
                  />
                  <span>Unassign all players from their CWL clans (CWL entries are kept)</span>
                </label>
              )}
              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={seasonBusy}
                  onClick={() => setConfirm(null)}
                  className="astral-btn-ghost justify-center"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={
                    seasonBusy ||
                    ((confirm.kind === 'new_season' || confirm.kind === 'rename_season') && !nameInput.trim())
                  }
                  onClick={() => void runConfirm()}
                  className={
                    confirm.kind === 'close_season'
                      ? 'inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-2.5 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/25 disabled:opacity-50'
                      : 'astral-btn-primary justify-center disabled:opacity-50'
                  }
                >
                  {seasonBusy ? (
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  {confirm.kind === 'close_season' ? 'Close season' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ─── Delete CWL Clan Modal ─── */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm removal"
        >
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
