import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Flag,
  LoaderCircle,
  Plus,
  RefreshCw,
  Shield,
  Swords,
  Trash2,
  Trophy,
  User,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';

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

export default function ClansPage() {
  const [clans, setClans] = useState<CwlClan[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
      .select('clan_tag, clan_name, cwl_league, leader_name, badge_url')
      .order('clan_name');
    if (loadError) setError(loadError.message);
    else setClans((data ?? []) as CwlClan[]);
    setLoading(false);
  };

  useEffect(() => {
    void loadClans();
  }, []);

  const authedFetch = async (method: 'POST' | 'DELETE', clanTag: string) => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const response = await fetch('/api/cwl-clans', {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ clan_tag: clanTag }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(body.error || `Request failed (HTTP ${response.status}).`);
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
      await authedFetch('POST', tag);
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

  const handleDelete = async (clanTag: string) => {
    if (!window.confirm(`Remove ${clanTag} from the CWL directory?`)) return;
    setDeletingTag(clanTag);
    setError(null);
    setMessage(null);
    try {
      await authedFetch('DELETE', clanTag);
      setClans((current) => current.filter((clan) => clan.clan_tag !== clanTag));
      setMessage(`${clanTag} removed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeletingTag(null);
    }
  };

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Flag className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">CWL Clans</h2>
          </div>
          <p className="mt-1 text-sm text-astral-300/60">Our CWL lineup — add a tag and details fill in automatically.</p>
        </div>
        <div className="flex items-center gap-2 self-start md:self-auto">
          <button onClick={() => setShowAdd((current) => !current)} className="astral-btn-primary" title="Add clan">
            <Plus className="w-4 h-4" /> Add clan
          </button>
          <button onClick={() => void loadClans()} className="astral-btn-ghost" title="Refresh clans">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} className="astral-card p-5 md:ml-auto md:max-w-xl">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2 text-gold-300 font-medium"><Plus className="w-4 h-4" /> Add clan</div>
            <button type="button" onClick={() => setShowAdd(false)} className="p-2 text-astral-300/70 hover:text-white rounded-lg" title="Close add clan panel"><X className="w-4 h-4" /></button>
          </div>
          <label className="text-sm text-astral-200">Clan Tag <span className="text-rose-300">*</span>
            <input required maxLength={12} value={tagInput} onChange={(event) => setTagInput(normalizeTagInput(event.target.value))} placeholder="#CLANTAG" className="astral-input mt-1.5 w-full uppercase font-mono" />
          </label>
          <p className="mt-2 text-xs text-astral-300/50">Name, league, leader and banner are fetched automatically. Re-adding a tag refreshes its data.</p>
          <button type="submit" disabled={saving} className="astral-btn-primary mt-4">
            {saving ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Fetch & add clan
          </button>
        </form>
      )}

      {(error || message) && (
        <div className={`p-4 rounded-xl border text-sm flex items-start gap-3 ${error ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'}`}>
          {error && <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />}
          <p>{error || message}</p>
        </div>
      )}

      {loading ? (
        <div className="astral-card p-12 text-center text-astral-300/60">
          <LoaderCircle className="w-6 h-6 animate-spin mx-auto" />
          <p className="mt-3 text-sm">Loading clans...</p>
        </div>
      ) : clans.length === 0 ? (
        <div className="astral-card p-12 text-center">
          <Shield className="w-8 h-8 mx-auto text-astral-300/40" />
          <p className="mt-3 text-astral-200">No CWL clans yet.</p>
          <p className="mt-1 text-sm text-astral-300/50">Add your first clan tag above.</p>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {clans.map((clan) => (
            <article key={clan.clan_tag} className="astral-card overflow-hidden">
              <div className="p-5 flex items-start gap-4">
                {clan.badge_url ? (
                  <img src={clan.badge_url} alt="" className="w-16 h-16 object-contain shrink-0" />
                ) : (
                  <div className="w-16 h-16 rounded-xl bg-astral-700/30 flex items-center justify-center shrink-0">
                    <Shield className="w-8 h-8 text-gold-300" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-lg font-bold text-white truncate">
                    {clan.clan_name ?? 'Unknown clan'}
                  </h3>
                  <p className="text-xs text-gold-400/80 font-mono truncate">{clan.clan_tag}</p>
                  {clan.cwl_league && (
                    <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-gold-400/30 bg-gold-500/10 px-2.5 py-1 text-xs font-medium text-gold-300">
                      <Trophy className="w-3.5 h-3.5" /> {clan.cwl_league}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(clan.clan_tag)}
                  disabled={deletingTag === clan.clan_tag}
                  className="p-2 text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/10 rounded-lg shrink-0"
                  title={`Remove ${clan.clan_tag}`}
                >
                  {deletingTag === clan.clan_tag
                    ? <LoaderCircle className="w-4 h-4 animate-spin" />
                    : <Trash2 className="w-4 h-4" />}
                </button>
              </div>
              <div className="px-5 py-3 border-t border-astral-700/20 flex items-center gap-2 text-sm text-astral-200">
                <User className="w-4 h-4 text-astral-300/70" />
                <span className="text-astral-300/60 text-xs uppercase tracking-wide">Leader</span>
                <span className="ml-auto font-medium text-white truncate">{clan.leader_name ?? '—'}</span>
              </div>
              <div className="px-5 py-3 border-t border-astral-700/20 flex items-center gap-2 text-sm text-astral-200">
                <Swords className="w-4 h-4 text-astral-300/70" />
                <span className="text-astral-300/60 text-xs uppercase tracking-wide">Invite link</span>
                <a
                  href={`https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodeURIComponent(clan.clan_tag)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto font-mono text-xs text-gold-300 hover:text-gold-200 truncate"
                >
                  Open in game
                </a>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
