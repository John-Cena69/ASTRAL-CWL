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

