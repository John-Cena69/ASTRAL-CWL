import { useEffect, useState } from 'react';
import {
  AlertCircle,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Trash2,
  X,
  UserPlus,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import type { TrackedClan } from '@/types';

function valueColor(value: number): string {
  if (value <= 0) return 'text-amber-300';
  if (value < 1.5) return 'text-emerald-300';
  if (value < 2.5) return 'text-amber-400';
  return 'text-rose-300';
}

const ACCESS_PAGES = [
  ['cwl', 'CWL'],
  ['fillers', 'Fillers'],
  ['wars', 'Wars'],
  ['clan_management', 'Clan Management'],
  ['clan_access', 'Clan access'],
] as const;
const GLOBAL_PERMISSION_PAGES = ACCESS_PAGES.filter(([key]) => key !== 'clan_access');
const CLAN_ACCESS_PAGES = ACCESS_PAGES.filter(([key]) => key === 'clan_access');

function normalizeTagInput(value: string): string {
  return `#${value.trim().toUpperCase().replace(/^#+/, '')}`;
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
  const [accessUsers, setAccessUsers] = useState<{ discord_user_id: string; role: string }[]>([]);
  const [accessClans, setAccessClans] = useState<TrackedClan[]>([]);
  const [accessPermissions, setAccessPermissions] = useState<{ clan_tag: string; role: string; page_key: string; allowed: boolean }[]>([]);
  const [accessUserId, setAccessUserId] = useState('');
  const [accessRole, setAccessRole] = useState('');
  const [permissionClans, setPermissionClans] = useState<string[]>(['*']);
  const [permissionRole, setPermissionRole] = useState('');
  const [permissionAccess, setPermissionAccess] = useState<Record<string, boolean>>({});

  // Global strike config state
  const [strikeReasons, setStrikeReasons] = useState<{ id: string; value: number; reason_text: string; is_active: boolean }[]>([]);
  const [newReasonValue, setNewReasonValue] = useState('');
  const [newReasonText, setNewReasonText] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

  // Season reset state
  const [resetting, setResetting] = useState(false);
  const [resetSeason, setResetSeason] = useState('');
  const [showResetModal, setShowResetModal] = useState(false);

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

  useEffect(() => {
    void loadClans();
  }, []);

  const loadAccess = async () => {
    if (!supabase) return;
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await fetch('/api/access-management', {
        headers: session.session?.access_token ? { Authorization: `Bearer ${session.session.access_token}` } : {},
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        users?: { discord_user_id: string; role: string }[];
        clans?: TrackedClan[];
        permissions?: { clan_tag: string; role: string; page_key: string; allowed: boolean }[];
        error?: string;
      };
      if (!response.ok || !body.ok) throw new Error(body.error || 'Failed to load access settings.');
      setAccessUsers(body.users ?? []);
      setAccessClans(body.clans ?? []);
      setAccessPermissions(body.permissions ?? []);
      const availableRoles = [...new Set((body.users ?? []).map((user) => user.role).filter(Boolean))];
      if (!permissionRole && availableRoles[0]) setPermissionRole(availableRoles[0]);
      if (!accessRole && availableRoles[0]) setAccessRole(availableRoles[0]);

      // Load global strike config
      const configResp = await fetch('/api/strike-config?type=global', {
        headers: session.session?.access_token ? { Authorization: `Bearer ${session.session.access_token}` } : {},
      });
      const configBody = (await configResp.json().catch(() => ({}))) as {
        ok?: boolean;
        reasons?: { id: string; value: number; reason_text: string; is_active: boolean }[];
        error?: string;
      };
      if (configBody.ok) {
        setStrikeReasons(configBody.reasons ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access settings.');
    }
  };

  useEffect(() => {
    void loadAccess();
  }, []);

  const saveAccess = async (payload: Record<string, unknown>) => {
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
    setMessage('Access settings saved.');
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
        body: JSON.stringify({
          season: resetSeason.trim(),
        }),
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

  const effectivePermission = (clanTag: string, role: string, pageKey: string): boolean => {
    if (role === 'Developer' || role === 'Admin') return true;
    const exact = accessPermissions.find((permission) =>
      permission.clan_tag === clanTag && permission.role === role && permission.page_key === pageKey
    );
    if (exact) return exact.allowed;
    const global = accessPermissions.find((permission) =>
      permission.clan_tag === '*' && permission.role === role && permission.page_key === pageKey
    );
    if (global) return global.allowed;
    return true;
  };

  useEffect(() => {
    const selectedClan = permissionClans.find((clan) => clan !== '*');
    const values = Object.fromEntries(
      GLOBAL_PERMISSION_PAGES.map(([pageKey]) => [
        pageKey,
        effectivePermission('*', permissionRole, pageKey),
      ])
    );
    if (selectedClan) {
      values.clan_access = effectivePermission(selectedClan, permissionRole, 'clan_access');
    }
    setPermissionAccess(values);
  }, [accessPermissions, permissionClans, permissionRole]);

  const selectPermissionRole = (role: string) => {
    setPermissionRole(role);
    const selectedClan = permissionClans.find((clan) => clan !== '*');
    const values = Object.fromEntries(
      GLOBAL_PERMISSION_PAGES.map(([pageKey]) => [
        pageKey,
        effectivePermission('*', role, pageKey),
      ])
    );
    if (selectedClan) {
      values.clan_access = effectivePermission(selectedClan, role, 'clan_access');
    }
    setPermissionAccess(values);
  };

  const savePermissionMatrix = async () => {
    await saveAccess({
      action: 'save_permissions',
      role: permissionRole,
      clan_tags: ['*'],
      permissions: GLOBAL_PERMISSION_PAGES.map(([pageKey]) => ({
        page_key: pageKey,
        allowed: permissionAccess[pageKey] !== false,
      })),
    });
    const selectedClans = permissionClans.filter((clan) => clan !== '*');
    if (selectedClans.length > 0) {
      await saveAccess({
        action: 'save_permissions',
        role: permissionRole,
        clan_tags: selectedClans,
        permissions: CLAN_ACCESS_PAGES.map(([pageKey]) => ({
          page_key: pageKey,
          allowed: permissionAccess[pageKey] !== false,
        })),
      });
    }
  };

  const selectedAccessPages = permissionClans.includes('*')
    ? GLOBAL_PERMISSION_PAGES
    : [...GLOBAL_PERMISSION_PAGES, ...CLAN_ACCESS_PAGES];

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
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
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
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
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

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">Clan Management</h2>
          </div>

          <section className="astral-card p-5 space-y-5">
            <div>
              <h3 className="font-semibold text-astral-100">Access Management</h3>
              <p className="mt-1 text-sm text-astral-300/60">
                Assign existing database roles to Discord users and control global or per-clan page access.
              </p>
            </div>
            <div className="grid lg:grid-cols-2 gap-5">
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAccess({ action: 'save_user', discord_user_id: accessUserId, role: accessRole }).catch((err) => setError(err instanceof Error ? err.message : 'Failed to save user.'));
                }}
              >
                <h4 className="text-sm font-medium text-gold-300">Allowed user role</h4>
                <input value={accessUserId} onChange={(event) => setAccessUserId(event.target.value)} placeholder="Discord user ID" className="astral-input w-full" required />
                <select value={accessRole} onChange={(event) => setAccessRole(event.target.value)} className="astral-input w-full" required>
                  {[...new Set(['Developer', 'Admin', ...accessUsers.map((user) => user.role)])].filter(Boolean).map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
                <button className="astral-btn-primary" type="submit"><UserPlus className="w-4 h-4" /> Save User Role</button>
              </form>
              <div className="space-y-3">
                <h4 className="text-sm font-medium text-gold-300">Allowed pages by role</h4>
                <p className="text-xs text-astral-300/60">
                  Check the pages this role may open. Unchecked pages are denied when saved. Select multiple clans to apply the same settings in one save.
                </p>
                <select
                  value={permissionRole}
                  onChange={(event) => selectPermissionRole(event.target.value)}
                  className="astral-input w-full"
                >
                  {[...new Set(['Developer', 'Admin', ...accessUsers.map((user) => user.role)])].map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
                <select
                  multiple
                  value={permissionClans}
                  onChange={(event) => {
                    const scopes = Array.from(event.target.selectedOptions, (option) => option.value);
                    setPermissionClans(scopes);
                    const referenceClan = scopes[0] ?? '*';
                    setPermissionAccess(Object.fromEntries(
                      ACCESS_PAGES.map(([pageKey]) => [pageKey, effectivePermission(referenceClan, permissionRole, pageKey)])
                    ));
                  }}
                  className="astral-input w-full min-h-28"
                >
                  <option value="*">All clans / global</option>
                  {accessClans.map((clan) => <option key={clan.clan_tag} value={clan.clan_tag}>{clan.clan_name}</option>)}
                </select>
                <p className="text-xs text-astral-300/50">Hold Ctrl or Cmd to select multiple clans.</p>
                <div className="rounded-lg border border-astral-700/30 divide-y divide-astral-700/20">
                  {selectedAccessPages.map(([pageKey, label]) => (
                    <label key={pageKey} className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-astral-200">
                      <span>{label}</span>
                      <input
                        type="checkbox"
                        checked={permissionAccess[pageKey] ?? true}
                        onChange={(event) => setPermissionAccess((current) => ({ ...current, [pageKey]: event.target.checked }))}
                      />
                    </label>
                  ))}
                </div>
                <button
                  className="astral-btn-primary"
                  type="button"
                  onClick={() => void savePermissionMatrix().catch((err) => setError(err instanceof Error ? err.message : 'Failed to save permissions.'))}
                >
                  <Shield className="w-4 h-4" /> Save Page Access
                </button>
              </div>
            </div>
            <div className="grid lg:grid-cols-2 gap-5 text-sm">
              <div>
                <h4 className="mb-2 text-astral-200">Allowed users</h4>
                {accessUsers.map((user) => <div key={user.discord_user_id} className="flex justify-between border-t border-astral-700/20 py-2"><span className="font-mono">{user.discord_user_id}</span><span className="text-gold-300">{user.role}</span></div>)}
              </div>
              <div>
                <h4 className="mb-2 text-astral-200">Allowed pages</h4>
                {accessPermissions.length === 0 && (
                  <p className="text-xs text-astral-300/50">No overrides configured. All allowlisted roles currently have access by default.</p>
                )}
                {accessPermissions.filter((permission) => permission.allowed).map((permission) => {
                  const clan = accessClans.find((item) => item.clan_tag === permission.clan_tag);
                  const page = ACCESS_PAGES.find(([key]) => key === permission.page_key)?.[1] ?? permission.page_key;
                  return (
                    <div key={`${permission.clan_tag}-${permission.role}-${permission.page_key}`} className="flex justify-between gap-3 border-t border-astral-700/20 py-2">
                      <span>{permission.clan_tag === '*' ? 'All clans' : clan?.clan_name ?? permission.clan_tag} · {page}</span>
                      <span className={permission.allowed ? 'text-emerald-300' : 'text-rose-300'}>{permission.role}: {permission.allowed ? 'Allowed' : 'Denied'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
          <section className="astral-card p-5 space-y-5 mt-4">
            <div>
              <h3 className="font-semibold text-astral-100">Global Strike Config</h3>
              <p className="mt-1 text-sm text-astral-300/60">
                Define global strike value + reason pairs available to all clans.
              </p>
            </div>
            <div className="space-y-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-astral-300/60">Strike Reasons (Value + Reason)</h4>
              <div className="space-y-2">
                {strikeReasons.length === 0 ? (
                  <p className="text-xs text-astral-300/50">No reasons configured.</p>
                ) : (
                  strikeReasons.map((r) => (
                    <div key={r.id} className="flex items-center justify-between p-2 bg-space-900/40 rounded-lg border border-astral-700/30">
                      <span className="text-astral-200 font-medium">{r.reason_text}</span>
                      <span className={`text-xs font-mono ${valueColor(r.value)} ml-2`}>{r.value}</span>
                      <div className="flex items-center gap-1">
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
              <div className="pt-4 border-t border-astral-700/30">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-astral-300/60 mb-2">Add Reason</h4>
                <div className="space-y-2">
                  <input
                    type="number"
                    step="0.5"
                    value={newReasonValue}
                    onChange={(e) => setNewReasonValue(e.target.value)}
                    placeholder="Value (e.g. 1.0)"
                    className="astral-input w-full text-sm"
                  />
                  <input
                    type="text"
                    value={newReasonText}
                    onChange={(e) => setNewReasonText(e.target.value)}
                    placeholder="Reason text (e.g. Missed War hits)"
                    className="astral-input w-full text-sm"
                  />
                  <button
                    onClick={() => void saveStrikeReason(null, newReasonValue, newReasonText, true)}
                    disabled={savingConfig || !newReasonValue || !newReasonText.trim()}
                    className="astral-btn-primary text-xs px-3"
                  >
                    {savingConfig ? <LoaderCircle className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          </section>
          <section className="astral-card p-5 space-y-5 mt-4">
            <div>
              <h3 className="font-semibold text-astral-100">Season Reset</h3>
              <p className="mt-1 text-sm text-astral-300/60">
                Archive all active confirmed strikes across every clan under a season name. This cannot be undone.
              </p>
            </div>
            <div className="space-y-4">
              <button
                onClick={() => {
                  setResetSeason('');
                  setShowResetModal(true);
                }}
                className="astral-btn-primary text-xs px-3 py-2 w-full"
              >
                {resetting ? <LoaderCircle className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                Reset Strikes for Season
              </button>
            </div>
          </section>
          <p className="mt-1 text-sm text-astral-300/60">
            Developer only. Add or remove tracked clans that appear as sidebar categories.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={() => void loadClans()}
            className="astral-btn-ghost" title="Refresh clan list">
            <RefreshCw className="w-4 h-4" /> Refresh
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

      {message && !error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200">
          <UserPlus className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <p className="text-sm flex-1">{message}</p>
          <button
            type="button"
            onClick={() => setMessage(null)}
            className="p-1 rounded-lg opacity-60 hover:opacity-100 hover:bg-white/10 transition shrink-0"
            title="Dismiss"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4">
        <form
          onSubmit={handleAdd}
          className="astral-card p-5 md:max-w-lg"
        >
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2 text-gold-300 font-medium">
              <Plus className="w-4 h-4" /> Add tracked clan
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="text-sm text-astral-200">Clan Tag <span className="text-rose-300">*</span>
              <input
                required
                maxLength={12}
                value={tagInput}
                onChange={(e) => setTagInput(normalizeTagInput(e.target.value))}
                placeholder="#CLANTAG"
                className="astral-input mt-1.5 w-full uppercase font-mono"
              />
            </label>
            <label className="text-sm text-astral-200">Clan Name <span className="text-rose-300">*</span>
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
            {loading ? (
              <LoaderCircle className="w-4 h-4 animate-spin" />
            ) : null}
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
                      No tracked clans yet. Add one above.
                    </td>
                  </tr>
                ) : (
                  clans.map((clan) => (
                    <tr
                      key={clan.clan_tag}
                      className="border-t border-astral-700/15 hover:bg-astral-700/10"
                    >
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
