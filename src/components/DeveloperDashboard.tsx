import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Eye,
  Lock,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Sparkles,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import type { TrackedClan } from '@/types';

type AccessLevel = 'none' | 'view' | 'edit';

interface DiscordSummary {
  discord_id: string;
  nickname: string;
  username: string;
  avatar_url: string | null;
}

interface AllowedUserRow {
  discord_user_id: string;
  role: string;
  created_at?: string;
  discord?: DiscordSummary;
}

interface PermissionRule {
  clan_tag: string;
  role: string;
  page_key: string;
  allowed: boolean;
  access_level?: AccessLevel;
}

function valueColor(value: number): string {
  if (value <= 0) return 'text-amber-300';
  if (value < 1.5) return 'text-emerald-300';
  if (value < 2.5) return 'text-amber-400';
  return 'text-rose-300';
}

const GLOBAL_PERMISSION_PAGES = [
  ['cwl', 'CWL (Clans, Entries & Roster)', 'Manage CWL clans, signups, and rosters'],
  ['fillers', 'Filler Accounts', 'View or manage alliance filler accounts'],
  ['wars', 'Wars & Sync', 'View family wars and FWA sync controls'],
  ['clan_management', 'Clan Management', 'Manage tracked clans, users, and permissions'],
] as const;

const CLAN_ACCESS_PAGES = [
  ['clan_access', 'Clan Access (All Pages)', 'Master access for all pages under selected clan(s)'],
  ['clan_home', 'Clan Home (Roster)', 'Member roster, Discord links, and player edits'],
  ['war_weights', 'War Weights', 'War weight values and CoC war roster sync'],
] as const;

const ALL_PERMISSION_LABELS: Record<string, string> = Object.fromEntries([
  ...GLOBAL_PERMISSION_PAGES.map(([k, label]) => [k, label]),
  ...CLAN_ACCESS_PAGES.map(([k, label]) => [k, label]),
]);

const DEFAULT_ROLES = ['Developer', 'Admin', 'Leader', 'Co-Leader', 'Staff', 'Viewer'];

function normalizeTagInput(value: string): string {
  return `#${value.trim().toUpperCase().replace(/^#+/, '')}`;
}

function resolveRuleLevel(rule?: PermissionRule): AccessLevel {
  if (!rule) return 'edit';
  if (rule.access_level === 'none' || rule.access_level === 'view' || rule.access_level === 'edit') {
    return rule.access_level;
  }
  return rule.allowed ? 'edit' : 'none';
}

function levelBadge(level: AccessLevel): { label: string; className: string } {
  if (level === 'edit') {
    return {
      label: 'View & Edit',
      className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    };
  }
  if (level === 'view') {
    return {
      label: 'View Only',
      className: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    };
  }
  return {
    label: 'Denied',
    className: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  };
}

export default function DeveloperDashboard() {
  const [clans, setClans] = useState<TrackedClan[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [removingTag, setRemovingTag] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [accessUsers, setAccessUsers] = useState<AllowedUserRow[]>([]);
  const [accessClans, setAccessClans] = useState<TrackedClan[]>([]);
  const [accessPermissions, setAccessPermissions] = useState<PermissionRule[]>([]);
  const [accessUserId, setAccessUserId] = useState('');
  const [accessRole, setAccessRole] = useState('Viewer');
  const [savingUser, setSavingUser] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);

  const [openDiscordId, setOpenDiscordId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  const [permissionClans, setPermissionClans] = useState<string[]>(['*']);
  const [permissionRole, setPermissionRole] = useState('Viewer');
  const [permissionLevels, setPermissionLevels] = useState<Record<string, AccessLevel>>({});
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [rulesRoleFilter, setRulesRoleFilter] = useState<string>('ALL');

  // Global strike config state
  const [strikeReasons, setStrikeReasons] = useState<{ id: string; value: number; reason_text: string; is_active: boolean }[]>([]);
  const [newReasonValue, setNewReasonValue] = useState('');
  const [newReasonText, setNewReasonText] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

  // Season reset state
  const [resetting, setResetting] = useState(false);
  const [resetSeason, setResetSeason] = useState('');
  const [showResetModal, setShowResetModal] = useState(false);

  useEffect(() => {
    if (!openDiscordId) return;
    const handleOutside = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        setOpenDiscordId(null);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [openDiscordId]);

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1500);
    } catch {
      // ignore clipboard failures
    }
  };

  const loadClans = async () => {
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
      const response = await fetch('/api/tracked-clans', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        clans?: TrackedClan[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Failed to load clans (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Failed to load clans.');
      setClans(body.clans ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load clans.');
    } finally {
      setLoading(false);
    }
  };

  const loadAccess = async () => {
    if (!supabase) return;
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch('/api/access-management', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        users?: AllowedUserRow[];
        clans?: TrackedClan[];
        permissions?: PermissionRule[];
        error?: string;
      };
      if (!response.ok || !body.ok) throw new Error(body.error || 'Failed to load access settings.');
      setAccessUsers(body.users ?? []);
      setAccessClans(body.clans ?? []);
      setAccessPermissions(body.permissions ?? []);

      const configResp = await fetch('/api/strike-config?type=global', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const configBody = (await configResp.json().catch(() => ({}))) as {
        ok?: boolean;
        reasons?: { id: string; value: number; reason_text: string; is_active: boolean }[];
      };
      if (configBody.ok) {
        setStrikeReasons(configBody.reasons ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access settings.');
    }
  };

  useEffect(() => {
    void loadClans();
    void loadAccess();
  }, []);

  const saveAccess = async (payload: Record<string, unknown>, successText = 'Access settings saved.') => {
    if (!supabase) return;
    const { data: session } = await supabase.auth.getSession();
    const response = await fetch('/api/access-management', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session.session?.access_token ? { Authorization: `Bearer ${session.session.access_token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || !body.ok) throw new Error(body.error || 'Failed to save access settings.');
    await loadAccess();
    setMessage(successText);
  };

  const effectiveAccessLevel = (clanTag: string, role: string, pageKey: string): AccessLevel => {
    if (role.toLowerCase() === 'developer' || role.toLowerCase() === 'admin') return 'edit';
    const exact = accessPermissions.find(
      (p) => p.clan_tag === clanTag && p.role.toLowerCase() === role.toLowerCase() && p.page_key === pageKey
    );
    if (exact) return resolveRuleLevel(exact);
    const global = accessPermissions.find(
      (p) => p.clan_tag === '*' && p.role.toLowerCase() === role.toLowerCase() && p.page_key === pageKey
    );
    if (global) return resolveRuleLevel(global);
    return 'edit';
  };

  useEffect(() => {
    const selectedClan = permissionClans.find((c) => c !== '*');
    const next: Record<string, AccessLevel> = {};
    for (const [pageKey] of GLOBAL_PERMISSION_PAGES) {
      next[pageKey] = effectiveAccessLevel('*', permissionRole, pageKey);
    }
    if (selectedClan) {
      for (const [pageKey] of CLAN_ACCESS_PAGES) {
        next[pageKey] = effectiveAccessLevel(selectedClan, permissionRole, pageKey);
      }
    }
    setPermissionLevels(next);
  }, [accessPermissions, permissionClans, permissionRole]);

  const roleOptions = [...new Set([...DEFAULT_ROLES, ...accessUsers.map((u) => u.role).filter(Boolean)])];

  const handleSaveUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!accessUserId.trim() || !accessRole.trim()) return;
    setSavingUser(true);
    setError(null);
    try {
      await saveAccess(
        { action: 'save_user', discord_user_id: accessUserId.trim(), role: accessRole.trim() },
        `Saved role "${accessRole.trim()}" for Discord ID ${accessUserId.trim()}.`
      );
      setAccessUserId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save user.');
    } finally {
      setSavingUser(false);
    }
  };

  const handleDeleteUser = async (discordUserId: string) => {
    if (!window.confirm(`Remove Discord ID ${discordUserId} from the allowlist?`)) return;
    setDeletingUserId(discordUserId);
    setError(null);
    try {
      await saveAccess(
        { action: 'delete_user', discord_user_id: discordUserId },
        `Removed ${discordUserId} from allowlisted users.`
      );
      setOpenDiscordId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove user.');
    } finally {
      setDeletingUserId(null);
    }
  };

  const toggleClanScope = (tag: string) => {
    if (tag === '*') {
      setPermissionClans(['*']);
      return;
    }
    setPermissionClans((prev) => {
      const withoutGlobal = prev.filter((item) => item !== '*');
      if (withoutGlobal.includes(tag)) {
        const remaining = withoutGlobal.filter((item) => item !== tag);
        return remaining.length > 0 ? remaining : ['*'];
      }
      return [...withoutGlobal, tag];
    });
  };

  const savePermissionMatrix = async () => {
    setSavingPermissions(true);
    setError(null);
    try {
      await saveAccess({
        action: 'save_permissions',
        role: permissionRole,
        clan_tags: ['*'],
        permissions: GLOBAL_PERMISSION_PAGES.map(([pageKey]) => ({
          page_key: pageKey,
          access_level: permissionLevels[pageKey] ?? 'edit',
        })),
      });

      const selectedClans = permissionClans.filter((c) => c !== '*');
      if (selectedClans.length > 0) {
        await saveAccess({
          action: 'save_permissions',
          role: permissionRole,
          clan_tags: selectedClans,
          permissions: CLAN_ACCESS_PAGES.map(([pageKey]) => ({
            page_key: pageKey,
            access_level: permissionLevels[pageKey] ?? 'edit',
          })),
        });
      }
      setMessage(`Updated view/edit permissions for "${permissionRole}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save permissions.');
    } finally {
      setSavingPermissions(false);
    }
  };

  const saveStrikeReason = async (id: string | null, value: string, reasonText: string, isActive: boolean) => {
    if (!supabase) return;
    const val = parseFloat(value);
    if (isNaN(val) || !reasonText.trim()) {
      setError('Value and reason text are required.');
      return;
    }
    setSavingConfig(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await fetch('/api/strike-config?type=global', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session.session?.access_token ? { Authorization: `Bearer ${session.session.access_token}` } : {}),
        },
        body: JSON.stringify({
          action: 'save_reason',
          id: id ?? '',
          value: val,
          reason_text: reasonText.trim(),
          is_active: isActive,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || 'Failed to save strike reason.');
      setNewReasonValue('');
      setNewReasonText('');
      await loadAccess();
      setMessage('Strike reason saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingConfig(false);
    }
  };

  const deleteStrikeReason = async (id: string) => {
    if (!supabase) return;
    setSavingConfig(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await fetch('/api/strike-config?type=global', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session.session?.access_token ? { Authorization: `Bearer ${session.session.access_token}` } : {}),
        },
        body: JSON.stringify({ action: 'delete_reason', id }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || 'Failed to delete strike reason.');
      await loadAccess();
      setMessage('Strike reason deleted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleSeasonReset = async () => {
    if (!supabase || resetting || !resetSeason.trim()) return;
    setResetting(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch('/api/strikes?action=reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ season: resetSeason.trim() }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        archived?: number;
      };
      if (!response.ok) throw new Error(body.error || `Reset failed (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Reset failed.');
      setMessage(`Season "${resetSeason}" — archived ${body.archived ?? 0} strike(s).`);
      setShowResetModal(false);
      await loadAccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed.');
    } finally {
      setResetting(false);
    }
  };

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!supabase) return;
    const tag = normalizeTagInput(tagInput);
    const name = nameInput.trim();
    if (tag.length < 4 || !name) {
      setError('Enter a valid clan tag and name.');
      return;
    }
    setAdding(true);
    setError(null);
    setMessage(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch('/api/tracked-clans', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ clan_tag: tag, clan_name: name }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error || `Failed to add clan (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Failed to add clan.');
      setTagInput('');
      setNameInput('');
      setMessage(`${name} (${tag}) added to tracked clans.`);
      await loadClans();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Add failed.');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (clanTag: string) => {
    if (!supabase || !window.confirm(`Remove ${clanTag} from tracked clans?`)) return;
    setRemovingTag(clanTag);
    setError(null);
    setMessage(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch(`/api/tracked-clans?clan_tag=${encodeURIComponent(clanTag.replace(/^#+/, ''))}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error || `Failed to remove clan (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Failed to remove clan.');
      setMessage(`${clanTag} removed from tracked clans.`);
      await loadClans();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed.');
    } finally {
      setRemovingTag(null);
    }
  };

  const isAdminRole = permissionRole.toLowerCase() === 'developer' || permissionRole.toLowerCase() === 'admin';
  const showClanPages = !permissionClans.includes('*');
  const activePagesList = showClanPages
    ? [...GLOBAL_PERMISSION_PAGES, ...CLAN_ACCESS_PAGES]
    : [...GLOBAL_PERMISSION_PAGES];

  const filteredRules = accessPermissions.filter(
    (rule) => rulesRoleFilter === 'ALL' || rule.role.toLowerCase() === rulesRoleFilter.toLowerCase()
  );

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">Clan Management</h2>
          </div>
          <p className="mt-1 text-sm text-astral-300/60">
            Manage allowlisted Discord users, view/edit role permissions, tracked clans, and strike settings.
          </p>
        </div>
        <button
          onClick={() => {
            void loadClans();
            void loadAccess();
          }}
          className="astral-btn-ghost self-start sm:self-auto"
          title="Refresh management data"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <p className="text-sm flex-1">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="p-1 rounded-lg opacity-60 hover:opacity-100 hover:bg-white/10 transition shrink-0"
            aria-label="Dismiss error"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {message && !error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200">
          <Check className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <p className="text-sm flex-1">{message}</p>
          <button
            type="button"
            onClick={() => setMessage(null)}
            className="p-1 rounded-lg opacity-60 hover:opacity-100 hover:bg-white/10 transition shrink-0"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* === Access Management === */}
      <section className="astral-card p-5 sm:p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-4 border-b border-astral-700/30">
          <div>
            <h3 className="font-semibold text-lg text-white">Access Management</h3>
            <p className="text-sm text-astral-300/60">
              Assign roles to Discord accounts and configure granular No Access, View Only, or View &amp; Edit permissions.
            </p>
          </div>
          <span className="text-xs px-2.5 py-1 rounded-full bg-astral-800/70 border border-astral-600/30 text-astral-200 self-start sm:self-auto">
            {accessUsers.length} Allowlisted User{accessUsers.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="grid lg:grid-cols-12 gap-6">
          {/* Left: Allowed Users + Add Form */}
          <div className="lg:col-span-5 space-y-4">
            <form onSubmit={handleSaveUser} className="p-4 rounded-xl bg-space-900/50 border border-astral-700/30 space-y-3">
              <h4 className="text-sm font-semibold text-gold-300 flex items-center gap-2">
                <UserPlus className="w-4 h-4" /> Add or Update User Role
              </h4>
              <div className="space-y-2.5">
                <input
                  value={accessUserId}
                  onChange={(e) => setAccessUserId(e.target.value)}
                  placeholder="Discord User ID (e.g. 123456789012345678)"
                  className="astral-input w-full text-sm font-mono"
                  required
                />
                <div className="flex gap-2">
                  <select
                    value={accessRole}
                    onChange={(e) => setAccessRole(e.target.value)}
                    className="astral-input flex-1 text-sm"
                    required
                  >
                    {roleOptions.map((role) => (
                      <option key={role} value={role}>{role}</option>
                    ))}
                  </select>
                  <button className="astral-btn-primary text-sm shrink-0" type="submit" disabled={savingUser}>
                    {savingUser ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                    Save
                  </button>
                </div>
              </div>
            </form>

            {/* Allowed Users List with @discord theme */}
            <div className="rounded-xl bg-space-900/40 border border-astral-700/30 p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-astral-100">Allowed Users</h4>
                <span className="text-xs text-astral-300/50">Click @profile for details</span>
              </div>

              {accessUsers.length === 0 ? (
                <p className="text-xs text-astral-300/50 py-4 text-center">No allowlisted users found.</p>
              ) : (
                <div className="divide-y divide-astral-700/20">
                  {accessUsers.map((user) => {
                    const discord = user.discord;
                    const displayNick = discord?.nickname || user.discord_user_id;
                    const displayUsername = discord?.username || user.discord_user_id;
                    const isOpen = openDiscordId === user.discord_user_id;

                    return (
                      <div
                        key={user.discord_user_id}
                        className="py-2.5 flex items-center justify-between gap-3 relative"
                      >
                        <div className="relative min-w-0" ref={isOpen ? popupRef : undefined}>
                          <button
                            type="button"
                            onClick={() => setOpenDiscordId(isOpen ? null : user.discord_user_id)}
                            className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-[#2b224c]/90 hover:bg-[#372b61] border border-astral-400/60 shadow-md shadow-astral-950/60 transition cursor-pointer group max-w-full"
                            title="Click to view Discord profile"
                            aria-expanded={isOpen}
                          >
                            {discord?.avatar_url ? (
                              <img
                                src={discord.avatar_url}
                                alt={displayNick}
                                className="w-5 h-5 rounded-full object-cover border border-astral-300/40 shrink-0"
                              />
                            ) : (
                              <div className="w-5 h-5 rounded-full bg-astral-700 flex items-center justify-center shrink-0">
                                <Sparkles className="w-3 h-3 text-astral-200" />
                              </div>
                            )}
                            <span className="text-sm font-semibold text-[#c9cdfb] group-hover:text-white transition truncate">
                              @{displayNick}
                            </span>
                          </button>

                          {isOpen && (
                            <div className="absolute left-0 mt-2 w-72 z-30 rounded-2xl bg-space-800/95 backdrop-blur-xl border border-astral-500/50 p-4 shadow-2xl shadow-space-950">
                              <div className="flex items-start justify-between gap-3 pb-3 border-b border-astral-700/40">
                                <div className="flex items-center gap-3 min-w-0">
                                  {discord?.avatar_url ? (
                                    <img
                                      src={discord.avatar_url}
                                      alt={displayNick}
                                      className="w-11 h-11 rounded-full object-cover border border-astral-400/60 shrink-0"
                                    />
                                  ) : (
                                    <div className="w-11 h-11 rounded-full bg-astral-700 flex items-center justify-center border border-astral-400/60 shrink-0">
                                      <Sparkles className="w-5 h-5 text-gold-300" />
                                    </div>
                                  )}
                                  <div className="min-w-0">
                                    <p className="text-sm font-bold text-white truncate">{displayNick}</p>
                                    <p className="text-xs text-astral-300 truncate">@{displayUsername}</p>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setOpenDiscordId(null)}
                                  className="p-1 rounded-lg text-astral-300/60 hover:text-white hover:bg-astral-700/30 transition"
                                  aria-label="Close Discord popup"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>

                              <div className="mt-3 space-y-2 text-xs">
                                <div className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-space-900/60">
                                  <span className="text-astral-300/70">Username</span>
                                  <button
                                    type="button"
                                    onClick={() => void copyText(displayUsername, `u-${user.discord_user_id}`)}
                                    className="inline-flex items-center gap-1 font-mono text-astral-100 hover:text-gold-300 transition truncate max-w-[150px]"
                                  >
                                    <span className="truncate">@{displayUsername}</span>
                                    {copiedKey === `u-${user.discord_user_id}` ? (
                                      <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                                    ) : (
                                      <Copy className="w-3 h-3 opacity-60 shrink-0" />
                                    )}
                                  </button>
                                </div>
                                <div className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-space-900/60">
                                  <span className="text-astral-300/70">Discord ID</span>
                                  <button
                                    type="button"
                                    onClick={() => void copyText(user.discord_user_id, `id-${user.discord_user_id}`)}
                                    className="inline-flex items-center gap-1 font-mono text-astral-100 hover:text-gold-300 transition"
                                  >
                                    <span>{user.discord_user_id}</span>
                                    {copiedKey === `id-${user.discord_user_id}` ? (
                                      <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                                    ) : (
                                      <Copy className="w-3 h-3 opacity-60 shrink-0" />
                                    )}
                                  </button>
                                </div>
                                <div className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-space-900/60">
                                  <span className="text-astral-300/70">Role</span>
                                  <span className="font-semibold text-gold-300">{user.role}</span>
                                </div>
                              </div>

                              <div className="mt-3 pt-3 border-t border-astral-700/30 flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAccessUserId(user.discord_user_id);
                                    setAccessRole(user.role);
                                    setOpenDiscordId(null);
                                  }}
                                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-astral-700/30 hover:bg-astral-700/50 text-astral-100 text-xs font-medium transition"
                                >
                                  <Pencil className="w-3.5 h-3.5" /> Edit Role
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteUser(user.discord_user_id)}
                                  disabled={deletingUserId === user.discord_user_id}
                                  className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-200 text-xs font-medium transition"
                                >
                                  {deletingUserId === user.discord_user_id ? (
                                    <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                  )}
                                  Remove
                                </button>
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gold-400/10 border border-gold-400/30 text-gold-300 font-medium">
                            {user.role}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right: Granular View / Edit Permission Matrix */}
          <div className="lg:col-span-7 space-y-4">
            <div className="p-4 rounded-xl bg-space-900/50 border border-astral-700/30 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-gold-300">Role Permissions (View &amp; Edit)</h4>
                  <p className="text-xs text-astral-300/60 mt-0.5">
                    Select a role and scope, then choose No Access, View Only, or View &amp; Edit per page.
                  </p>
                </div>
                <select
                  value={permissionRole}
                  onChange={(e) => setPermissionRole(e.target.value)}
                  className="astral-input text-sm sm:w-44"
                >
                  {roleOptions.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
              </div>

              {/* Scope Pills */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-astral-300/70">Target Scope (click to select one or multiple clans)</span>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleClanScope('*')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                      permissionClans.includes('*')
                        ? 'bg-gold-400/20 border-gold-400/50 text-gold-200'
                        : 'bg-space-800/60 border-astral-700/40 text-astral-300/70 hover:text-white'
                    }`}
                  >
                    All Clans / Global
                  </button>
                  {accessClans.map((clan) => {
                    const selected = permissionClans.includes(clan.clan_tag);
                    return (
                      <button
                        key={clan.clan_tag}
                        type="button"
                        onClick={() => toggleClanScope(clan.clan_tag)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                          selected
                            ? 'bg-astral-500/25 border-astral-400/60 text-white'
                            : 'bg-space-800/60 border-astral-700/40 text-astral-300/70 hover:text-white'
                        }`}
                      >
                        {clan.clan_name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {isAdminRole && (
                <div className="p-3 rounded-lg bg-gold-400/10 border border-gold-400/30 text-xs text-gold-200">
                  <strong>{permissionRole}</strong> always has full View &amp; Edit access across all pages and clans.
                </div>
              )}

              {/* 3-State Permission Matrix */}
              <div className="rounded-xl border border-astral-700/30 divide-y divide-astral-700/20 overflow-hidden">
                {activePagesList.map(([pageKey, label, desc]) => {
                  const currentLevel: AccessLevel = isAdminRole ? 'edit' : (permissionLevels[pageKey] ?? 'edit');
                  return (
                    <div
                      key={pageKey}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-3.5 py-3 bg-space-900/30"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-astral-100">{label}</p>
                        <p className="text-xs text-astral-300/50">{desc}</p>
                      </div>
                      <div className="inline-flex rounded-lg bg-space-950/70 p-0.5 border border-astral-700/30 shrink-0 self-start sm:self-auto">
                        {(
                          [
                            ['none', 'No Access', Lock, 'bg-rose-500/25 text-rose-200 border-rose-500/40'],
                            ['view', 'View', Eye, 'bg-sky-500/25 text-sky-200 border-sky-500/40'],
                            ['edit', 'Edit', Pencil, 'bg-emerald-500/25 text-emerald-200 border-emerald-500/40'],
                          ] as const
                        ).map(([level, btnLabel, Icon, activeCls]) => {
                          const active = currentLevel === level;
                          return (
                            <button
                              key={level}
                              type="button"
                              disabled={isAdminRole}
                              onClick={() =>
                                setPermissionLevels((prev) => ({ ...prev, [pageKey]: level }))
                              }
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition ${
                                active
                                  ? activeCls
                                  : 'border-transparent text-astral-300/60 hover:text-white'
                              } ${isAdminRole ? 'opacity-60 cursor-not-allowed' : ''}`}
                            >
                              <Icon className="w-3 h-3" />
                              {btnLabel}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-end">
                <button
                  className="astral-btn-primary"
                  type="button"
                  disabled={savingPermissions || isAdminRole}
                  onClick={() => void savePermissionMatrix()}
                >
                  {savingPermissions ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Page Access
                </button>
              </div>
            </div>

            {/* Configured Rules Summary */}
            <div className="p-4 rounded-xl bg-space-900/40 border border-astral-700/30 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-astral-100">Configured Permission Rules ({filteredRules.length})</h4>
                <select
                  value={rulesRoleFilter}
                  onChange={(e) => setRulesRoleFilter(e.target.value)}
                  className="astral-input text-xs py-1 px-2"
                >
                  <option value="ALL">All Roles</option>
                  {roleOptions.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
              </div>
              {filteredRules.length === 0 ? (
                <p className="text-xs text-astral-300/50 py-2">
                  No rules configured for this filter. Roles without rules default to full access.
                </p>
              ) : (
                <div className="max-h-60 overflow-y-auto divide-y divide-astral-700/20 pr-1">
                  {filteredRules.map((rule) => {
                    const clan = accessClans.find((c) => c.clan_tag === rule.clan_tag);
                    const pageLabel = ALL_PERMISSION_LABELS[rule.page_key] ?? rule.page_key;
                    const level = resolveRuleLevel(rule);
                    const badge = levelBadge(level);
                    return (
                      <div
                        key={`${rule.clan_tag}-${rule.role}-${rule.page_key}`}
                        className="flex items-center justify-between gap-3 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <span className="font-medium text-astral-100">
                            {rule.clan_tag === '*' ? 'All Clans' : clan?.clan_name ?? rule.clan_tag}
                          </span>
                          <span className="text-astral-300/50"> · {pageLabel}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-gold-300 font-medium">{rule.role}</span>
                          <span className={`px-2 py-0.5 rounded-full border ${badge.className}`}>
                            {badge.label}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* === Tracked Clans === */}
      <div className="flex flex-col md:flex-row gap-4">
        <form onSubmit={handleAdd} className="astral-card p-5 md:w-96 shrink-0">
          <div className="flex items-center gap-2 text-gold-300 font-medium mb-4">
            <Plus className="w-4 h-4" /> Add Tracked Clan
          </div>
          <div className="space-y-3">
            <label className="block text-sm text-astral-200">
              Clan Tag <span className="text-rose-300">*</span>
              <input
                required
                maxLength={12}
                value={tagInput}
                onChange={(e) => setTagInput(normalizeTagInput(e.target.value))}
                placeholder="#CLANTAG"
                className="astral-input mt-1.5 w-full uppercase font-mono"
              />
            </label>
            <label className="block text-sm text-astral-200">
              Clan Name <span className="text-rose-300">*</span>
              <input
                required
                maxLength={100}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Clan Name"
                className="astral-input mt-1.5 w-full"
              />
            </label>
          </div>
          <button type="submit" disabled={adding} className="astral-btn-primary mt-4 w-full">
            {adding ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {adding ? 'Adding...' : 'Add Clan'}
          </button>
        </form>

        <section className="astral-card flex-1 overflow-hidden">
          <div className="p-4 border-b border-astral-700/30 flex items-center justify-between">
            <h3 className="font-semibold text-astral-100">Tracked Clans ({clans.length})</h3>
            {loading ? <LoaderCircle className="w-4 h-4 animate-spin" /> : null}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-space-700/40">
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Clan Name</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Clan Tag</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Added</th>
                  <th className="px-4 py-3 text-right text-astral-300/60 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-astral-300/50">
                      <LoaderCircle className="w-5 h-5 animate-spin mx-auto" />
                    </td>
                  </tr>
                ) : clans.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-astral-300/50">
                      No tracked clans yet. Add one on the left.
                    </td>
                  </tr>
                ) : (
                  clans.map((clan) => (
                    <tr key={clan.clan_tag} className="border-t border-astral-700/15 hover:bg-astral-700/10">
                      <td className="px-4 py-3 text-astral-100 font-medium">{clan.clan_name}</td>
                      <td className="px-4 py-3 font-mono text-gold-300">{clan.clan_tag}</td>
                      <td className="px-4 py-3 text-astral-300/40 text-xs">
                        {clan.added_date ? new Date(clan.added_date).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => void handleDelete(clan.clan_tag)}
                          disabled={removingTag === clan.clan_tag}
                          className="p-2 text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/10 rounded-lg"
                          title={`Remove ${clan.clan_tag}`}
                        >
                          {removingTag === clan.clan_tag ? (
                            <LoaderCircle className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* === Global Strike Config & Season Reset === */}
      <div className="grid md:grid-cols-2 gap-4">
        <section className="astral-card p-5 space-y-4">
          <div>
            <h3 className="font-semibold text-astral-100">Global Strike Config</h3>
            <p className="mt-1 text-sm text-astral-300/60">
              Define global strike value + reason pairs available to all clans.
            </p>
          </div>
          <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
            {strikeReasons.length === 0 ? (
              <p className="text-xs text-astral-300/50">No reasons configured.</p>
            ) : (
              strikeReasons.map((r) => (
                <div key={r.id} className="flex items-center justify-between p-2.5 bg-space-900/40 rounded-lg border border-astral-700/30">
                  <span className="text-sm text-astral-200 font-medium">{r.reason_text}</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono ${valueColor(r.value)}`}>{r.value}</span>
                    <button
                      type="button"
                      onClick={() => void deleteStrikeReason(r.id)}
                      className="p-1 text-rose-300/70 hover:text-rose-200"
                      title="Delete reason"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="pt-3 border-t border-astral-700/30 flex flex-col sm:flex-row gap-2">
            <input
              type="number"
              step="0.5"
              value={newReasonValue}
              onChange={(e) => setNewReasonValue(e.target.value)}
              placeholder="Value (1.0)"
              className="astral-input sm:w-28 text-sm"
            />
            <input
              type="text"
              value={newReasonText}
              onChange={(e) => setNewReasonText(e.target.value)}
              placeholder="Reason text (e.g. Missed War hits)"
              className="astral-input flex-1 text-sm"
            />
            <button
              onClick={() => void saveStrikeReason(null, newReasonValue, newReasonText, true)}
              disabled={savingConfig || !newReasonValue || !newReasonText.trim()}
              className="astral-btn-primary text-xs px-3 shrink-0"
            >
              {savingConfig ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add
            </button>
          </div>
        </section>

        <section className="astral-card p-5 flex flex-col justify-between space-y-4">
          <div>
            <h3 className="font-semibold text-astral-100">Season Reset</h3>
            <p className="mt-1 text-sm text-astral-300/60">
              Archive all active confirmed strikes across every clan under a season name. This cannot be undone.
            </p>
          </div>
          <button
            onClick={() => {
              setResetSeason('');
              setShowResetModal(true);
            }}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-2.5 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/25 w-full sm:w-auto self-start"
          >
            {resetting ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Reset Strikes for Season
          </button>
        </section>
      </div>

      {/* === Season Reset Modal === */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Confirm season reset">
          <div
            className="absolute inset-0 bg-space-950/70 backdrop-blur-sm"
            onClick={() => setShowResetModal(false)}
            aria-hidden="true"
          />
          <div className="relative bg-space-800 border border-astral-700/30 rounded-2xl p-6 w-full max-w-sm text-center shadow-2xl shadow-space-950">
            <div className="mx-auto w-12 h-12 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center">
              <Trash2 className="w-6 h-6 text-rose-300" />
            </div>
            <h3 className="mt-4 font-display text-lg font-bold text-white">Reset Strikes for Season</h3>
            <p className="mt-2 text-sm text-astral-200/70">
              This will archive all active confirmed strikes across every clan under the season name below. This cannot be undone.
            </p>
            <div className="mt-4">
              <label className="block text-xs text-astral-300/60 uppercase tracking-wide mb-1">Season Name</label>
              <input
                type="text"
                value={resetSeason}
                onChange={(e) => setResetSeason(e.target.value)}
                placeholder="e.g. Sep-Oct 2026"
                className="astral-input w-full text-sm"
              />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setShowResetModal(false)}
                className="astral-btn-ghost justify-center"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSeasonReset}
                disabled={resetting || !resetSeason.trim()}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-2.5 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/25"
              >
                {resetting ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Reset Season
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
