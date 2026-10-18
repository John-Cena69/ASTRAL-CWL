import { useEffect, useState } from 'react';
import {
  AlertCircle,
  LoaderCircle,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
  UserPlus,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import type { TrackedClan } from '@/types';

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
  const [accessRole, setAccessRole] = useState('Viewer');
  const [permissionClan, setPermissionClan] = useState('');
  const [permissionRole, setPermissionRole] = useState('Viewer');
  const [permissionPage, setPermissionPage] = useState('clan_home');
  const [permissionAllowed, setPermissionAllowed] = useState(true);

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
      if (!permissionClan && body.clans?.[0]) setPermissionClan(body.clans[0].clan_tag);
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
                <input value={accessRole} onChange={(event) => setAccessRole(event.target.value)} placeholder="Role (for example Viewer)" className="astral-input w-full" required />
                <button className="astral-btn-primary" type="submit"><UserPlus className="w-4 h-4" /> Save User Role</button>
              </form>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAccess({ action: 'save_permission', clan_tag: permissionClan, role: permissionRole, page_key: permissionPage, allowed: permissionAllowed }).catch((err) => setError(err instanceof Error ? err.message : 'Failed to save permission.'));
                }}
              >
                <h4 className="text-sm font-medium text-gold-300">Per-clan page permission</h4>
                <select value={permissionClan} onChange={(event) => setPermissionClan(event.target.value)} className="astral-input w-full" required>
                  <option value="*">All clans / global page</option>
                  {accessClans.map((clan) => <option key={clan.clan_tag} value={clan.clan_tag}>{clan.clan_name}</option>)}
                </select>
                <input value={permissionRole} onChange={(event) => setPermissionRole(event.target.value)} placeholder="Role" className="astral-input w-full" required />
                <select value={permissionPage} onChange={(event) => setPermissionPage(event.target.value)} className="astral-input w-full">
                  <option value="roster">Main Roster</option>
                  <option value="clans">Clan Management</option>
                  <option value="accounts">Filler Accounts</option>
                  <option value="wars">Wars</option>
                  <option value="clan_home">Clan Home</option>
                  <option value="war_weights">War Weights</option>
                  <option value="user_management">User Management</option>
                </select>
                <label className="flex items-center gap-2 text-sm text-astral-200"><input type="checkbox" checked={permissionAllowed} onChange={(event) => setPermissionAllowed(event.target.checked)} /> Allow access</label>
                <button className="astral-btn-primary" type="submit"><Shield className="w-4 h-4" /> Save Permission</button>
              </form>
            </div>
            <div className="grid lg:grid-cols-2 gap-5 text-sm">
              <div>
                <h4 className="mb-2 text-astral-200">Allowed users</h4>
                {accessUsers.map((user) => <div key={user.discord_user_id} className="flex justify-between border-t border-astral-700/20 py-2"><span className="font-mono">{user.discord_user_id}</span><span className="text-gold-300">{user.role}</span></div>)}
              </div>
              <div>
                <h4 className="mb-2 text-astral-200">Configured permissions</h4>
                {accessPermissions.map((permission) => <div key={`${permission.clan_tag}-${permission.role}-${permission.page_key}`} className="flex justify-between border-t border-astral-700/20 py-2"><span>{permission.clan_tag} · {permission.page_key}</span><span className={permission.allowed ? 'text-emerald-300' : 'text-rose-300'}>{permission.role}: {permission.allowed ? 'Allowed' : 'Denied'}</span></div>)}
              </div>
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
    </main>
  );
}
