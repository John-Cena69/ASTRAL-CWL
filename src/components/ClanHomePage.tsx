import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Clock3,
  CopyIcon,
  Edit2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Star,
  Swords,
  Trash2,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import type { ClanRosterPlayer } from '@/types';
import { ROLE_OPTIONS } from '@/types';

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

export default function ClanHomePage({ clanTag, clanName }: ClanHomePageProps) {
  const [players, setPlayers] = useState<ClanRosterPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Add player form state
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [addPlayerTag, setAddPlayerTag] = useState('');
  const [addingPlayer, setAddingPlayer] = useState(false);

  // Edit form state
  const [editTag, setEditTag] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editJoinDate, setEditJoinDate] = useState('');

  const loadRoster = async () => {
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    if (!clanTag || !clanTag.trim()) {
      setError('Clan tag is required. Please select a clan from the sidebar.');
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

  const addPlayer = async () => {
    if (!supabase || addingPlayer) return;
    const tag = addPlayerTag.trim();
    if (!tag) {
      setError('Player tag is required.');
      return;
    }
    setAddingPlayer(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch('/api/add-clan-player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ clan_tag: clanTag, player_tag: tag }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Add failed (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Add failed.');
      setNotice(`Player added to ${clanName}.`);
      setAddPlayerTag('');
      setShowAddPlayer(false);
      await loadRoster();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Add failed.');
    } finally {
      setAddingPlayer(false);
    }
  };

  const startEdit = (player: ClanRosterPlayer) => {
    setEditingId(player.id);
    setEditTag(player.player_tag.replace(/^#/, ''));
    setEditRole(player.role ?? '');
    setEditJoinDate(player.join_date ? new Date(player.join_date).toISOString().split('T')[0] : '');
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTag('');
    setEditRole('');
    setEditJoinDate('');
  };

  const saveEdit = async (player: ClanRosterPlayer) => {
    if (!supabase) return;
    const tag = editTag.trim();
    const role = editRole.trim();
    const joinDate = editJoinDate.trim();

    if (!tag || !role) {
      setError('Player Tag and Role are both required.');
      return;
    }

    setSavingId(player.id);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const response = await fetch('/api/edit-clan-player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          clan_tag: clanTag,
          player_tag: player.player_tag,
          new_player_tag: `#${tag}`,
          role,
          ...(joinDate ? { join_date: joinDate } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Update failed (HTTP ${response.status}).`);
      if (!body.ok) throw new Error(body.error || 'Update failed.');
      setNotice(`Updated ${player.player_name}.`);
      cancelEdit();
      await loadRoster();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed.');
    } finally {
      setSavingId(null);
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
            Clan roster — synced manually via the button below. Join Date is hidden but drives Days in Clan.
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
          <button
            onClick={() => setShowAddPlayer((prev) => !prev)}
            className="astral-btn-primary" title="Add player to roster">
            <Plus className="w-4 h-4" /> Add Player
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

      {showAddPlayer && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void addPlayer();
          }}
          className="astral-card p-5 md:max-w-lg"
        >
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2 text-gold-300 font-medium">
              <Plus className="w-4 h-4" /> Add Player
            </div>
            <button
              type="button"
              onClick={() => setShowAddPlayer(false)}
              className="p-2 text-astral-300/70 hover:text-white rounded-lg" title="Close add player panel">
              <X className="w-4 h-4" />
            </button>
          </div>
          <label className="text-sm text-astral-200">Player Tag <span className="text-rose-300">*</span>
            <input
              required
              maxLength={15}
              value={addPlayerTag}
              onChange={(e) => setAddPlayerTag(e.target.value.toUpperCase())}
              placeholder="#PLAYER"
              className="astral-input mt-1.5 w-full uppercase font-mono"
            />
          </label>
          <p className="mt-2 text-xs text-astral-300/50">
            Player stats (name, town hall, role) will be fetched automatically from the CoC API.
          </p>
          <button type="submit" disabled={addingPlayer} className="astral-btn-primary mt-4 w-full">
            {addingPlayer ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {addingPlayer ? 'Adding...' : 'Add Player'}
          </button>
        </form>
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
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">Days in Clan</th>
                  <th className="px-4 py-3 text-left text-astral-300/60 font-medium">War Weight</th>
                  <th className="px-4 py-3 text-right text-astral-300/60 font-medium w-20">Action</th>
                </tr>
              </thead>
              <tbody>
                {players.map((player) => {
                  const isEditing = editingId === player.id;
                  return (
                    <tr
                      key={player.id}
                      className="border-t border-astral-700/15 hover:bg-astral-700/10 transition-colors group"
                    >
                      {isEditing ? (
                        <EditRow
                          player={player}
                          roles={ROLE_OPTIONS}
                          editTag={editTag}
                          editRole={editRole}
                          editJoinDate={editJoinDate}
                          onTagChange={(e) => setEditTag(e.target.value)}
                          onRoleChange={(e) => setEditRole(e.target.value)}
                          onJoinDateChange={(e) => setEditJoinDate(e.target.value)}
                          onSave={() => saveEdit(player)}
                          onCancel={cancelEdit}
                          saving={savingId === player.id}
                        />
                      ) : (
                        <ViewRow
                          player={player}
                          onEdit={() => startEdit(player)}
                        />
                      )}
                    </tr>
                  );
                })}
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

function ViewRow({ player, onEdit }: { player: ClanRosterPlayer; onEdit: () => void }) {
  return (
    <>
      <td className="px-4 py-3 text-astral-300/40 font-mono text-xs">
        {/* # column handled by parent index */}
        <span>—</span>
      </td>
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
          {player.discord_id && <CopyButton value={`<@${player.discord_id}`} />}
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
      <td className="px-4 py-3 text-astral-100 font-mono">{player.days_in_clan ?? '—'}</td>
      <td className="px-4 py-3 text-astral-100 font-mono text-gold-300">
        {player.war_weight ?? '—'}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          onClick={onEdit}
          className="p-1.5 text-gold-300/70 hover:text-gold-200 hover:bg-gold-500/10 rounded-lg"
          title="Edit player"
        >
          <Edit2 className="w-4 h-4" />
        </button>
      </td>
    </>
  );
}

function EditRow({
  player,
  roles,
  editTag,
  editRole,
  editJoinDate,
  onTagChange,
  onRoleChange,
  onJoinDateChange,
  onSave,
  onCancel,
  saving,
}: {
  player: ClanRosterPlayer;
  roles: string[];
  editTag: string;
  editRole: string;
  editJoinDate: string;
  onTagChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRoleChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onJoinDateChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <>
      <td className="px-4 py-3 text-astral-300/40 font-mono text-xs">{player.player_name.substring(0, 1)}.</td>
      <td className="px-4 py-3 text-astral-100 font-medium">{player.player_name}</td>
      <td className="px-4 py-3">
        <input
          type="text"
          value={editTag}
          onChange={onTagChange}
          className="astral-input w-full text-xs uppercase font-mono"
          placeholder="TAG"
        />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="text-astral-200">{player.discord_id || '—'}</span>
          {player.discord_id && <CopyButton value={`<@${player.discord_id}`} />}
        </div>
      </td>
      <td className="px-4 py-3 text-astral-100">{player.town_hall ?? '—'}</td>
      <td className="px-4 py-3">
        <select
          value={editRole}
          onChange={onRoleChange}
          className="astral-input w-full text-xs"
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
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
      <td className="px-4 py-3 text-astral-100 font-mono">
        <input
          type="date"
          value={editJoinDate}
          onChange={onJoinDateChange}
          className="astral-input w-full text-xs"
        />
      </td>
      <td className="px-4 py-3 text-astral-100 font-mono text-gold-300">
        {player.war_weight ?? '—'}
      </td>
      <td className="px-4 py-3 text-right flex gap-1">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="p-1.5 text-emerald-300/80 hover:text-emerald-200 hover:bg-emerald-500/10 rounded-lg disabled:opacity-50"
          title="Save"
        >
          {saving ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="p-1.5 text-astral-300/70 hover:text-white hover:bg-astral-700/30 rounded-lg"
          title="Cancel"
        >
          <X className="w-4 h-4" />
        </button>
      </td>
    </>
  );
}
