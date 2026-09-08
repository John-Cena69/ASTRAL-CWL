import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Database, Edit2, Filter, LoaderCircle, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { supabase } from '@/supabaseClient';

interface FillerAccount {
  player_tag: string;
  player_name: string | null;
  clan_tag: string | null;
  town_hall: number | null;
  war_weight: number | null;
  owner: string;
  clan_name?: string;
}

interface FamilyClan {
  clan_tag: string;
  clan_name: string;
}

type SortColumn = 'clan' | 'townHall' | 'owner';
type SortDirection = 'asc' | 'desc';

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

const emptyForm = { playerTag: '', owner: '' };
const AVAILABLE_FILTER = '__available__';

function normalizePlayerTag(value: string): string {
  return `#${value.trim().replace(/^#+/, '').toUpperCase()}`;
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<FillerAccount[]>([]);
  const [clans, setClans] = useState<FamilyClan[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [playerFilter, setPlayerFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [clanFilter, setClanFilter] = useState('');
  const [townHallFilter, setTownHallFilter] = useState('');
  const [sortState, setSortState] = useState<SortState>({ column: 'clan', direction: 'asc' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editingWeight, setEditingWeight] = useState('');
  const [updatingTag, setUpdatingTag] = useState<string | null>(null);
  const [editingOwner, setEditingOwner] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadAccounts = async () => {
    if (!supabase) {
      setError('Supabase is not configured. Add the values from .env.local and restart the app.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const [{ data: accountRows, error: accountError }, { data: clanRows, error: clanError }] =
      await Promise.all([
        supabase.from('filler_accounts').select('player_tag, player_name, clan_tag, town_hall, war_weight, owner').order('player_tag'),
        supabase.from('family_clans').select('clan_tag, clan_name').order('clan_name'),
      ]);

    if (accountError || clanError) {
      setError(accountError?.message || clanError?.message || 'Could not load account data.');
      setLoading(false);
      return;
    }

    const clanMap = new Map((clanRows ?? []).map((clan) => [clan.clan_tag, clan.clan_name]));
    setClans(clanRows ?? []);
    setAccounts(
      ((accountRows ?? []) as FillerAccount[]).map((account) => {
        const clanName = account.clan_tag ? clanMap.get(account.clan_tag) ?? 'Available' : 'Available';
        return {
          ...account,
          clan_tag: clanName === 'Available' ? null : account.clan_tag,
          clan_name: clanName,
        };
      })
    );
    setLoading(false);
  };

  useEffect(() => {
    void loadAccounts();
    const refreshTimer = window.setInterval(() => void loadAccounts(), 60_000);
    return () => window.clearInterval(refreshTimer);
  }, []);

  const filteredAccounts = useMemo(() => {
    const playerQuery = playerFilter.trim().toUpperCase();
    const ownerQuery = ownerFilter.trim().toUpperCase();
    return accounts.filter((account) =>
      (!playerQuery || account.player_tag.includes(playerQuery)) &&
      (!ownerQuery || account.owner.includes(ownerQuery)) &&
      (!clanFilter || (clanFilter === AVAILABLE_FILTER ? account.clan_name === 'Available' : account.clan_tag === clanFilter)) &&
      (!townHallFilter || (townHallFilter === 'none' ? account.town_hall === null : account.town_hall === Number(townHallFilter)))
    );
  }, [accounts, playerFilter, ownerFilter, clanFilter, townHallFilter]);

  const townHallOptions = useMemo(() => (
    [...new Set(accounts.map((account) => account.town_hall).filter((level): level is number => level !== null))]
      .sort((left, right) => left - right)
  ), [accounts]);

  const sortedAccounts = useMemo(() => {
    const sorted = [...filteredAccounts];
    sorted.sort((left, right) => {
      let comparison = 0;
      if (sortState.column === 'clan') {
        comparison = (left.clan_name ?? 'Available').localeCompare(right.clan_name ?? 'Available');
      } else if (sortState.column === 'owner') {
        comparison = left.owner.localeCompare(right.owner);
      } else {
        comparison = (left.town_hall ?? -1) - (right.town_hall ?? -1);
      }
      return sortState.direction === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [filteredAccounts, sortState]);

  const toggleSort = (column: SortColumn) => {
    setSortState((current) => current.column === column
      ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { column, direction: 'asc' });
  };

  const sortIcon = (column: SortColumn) => {
    if (sortState.column !== column) return <ArrowUpDown className="w-3.5 h-3.5 opacity-30" />;
    return sortState.direction === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-gold-400" />
      : <ArrowDown className="w-3.5 h-3.5 text-gold-400" />;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!supabase) return;

    const rawPlayerTag = form.playerTag.trim().replace(/^#+/, '');
    const playerTag = normalizePlayerTag(rawPlayerTag);
    const owner = form.owner.trim().toUpperCase();
    if (!rawPlayerTag || !owner) {
      setError('Player Tag and Owner are both required.');
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    const { error: insertError } = await supabase
      .from('filler_accounts')
      .insert({ player_tag: playerTag, owner });

    if (insertError) {
      setError(insertError.code === '23505' ? 'That Player Tag is already entered.' : insertError.message);
    } else {
      setForm(emptyForm);
      setShowAddAccount(false);
      setMessage(`${playerTag} was added.`);
      await loadAccounts();
    }
    setSaving(false);
  };

  const handleDelete = async (playerTag: string) => {
    if (!supabase || !window.confirm(`Delete ${playerTag}?`)) return;

    setDeletingTag(playerTag);
    setError(null);
    const { error: deleteError } = await supabase.from('filler_accounts').delete().eq('player_tag', playerTag);
    if (deleteError) setError(deleteError.message);
    else setAccounts((current) => current.filter((account) => account.player_tag !== playerTag));
    setDeletingTag(null);
  };

  const startWeightEdit = (account: FillerAccount) => {
    setEditingTag(account.player_tag);
    setEditingWeight(account.war_weight === null ? '' : String(account.war_weight));
    setEditingOwner(account.owner);
    setError(null);
  };

  const cancelWeightEdit = () => {
    setEditingTag(null);
    setEditingWeight('');
    setEditingOwner('');
  };

  const saveWeight = async (playerTag: string) => {
    if (!supabase) return;
    const trimmedWeight = editingWeight.trim();
    const warWeight = trimmedWeight === '' ? null : Number(trimmedWeight);
    const owner = editingOwner.trim().toUpperCase();
    if (warWeight !== null && (!Number.isInteger(warWeight) || warWeight < 0)) {
      setError('War Weight must be a whole number of 0 or greater.');
      return;
    }
    if (!owner) {
      setError('Owner is required.');
      return;
    }

    setUpdatingTag(playerTag);
    setError(null);
    const { error: updateError } = await supabase
      .from('filler_accounts')
      .update({ war_weight: warWeight, owner })
      .eq('player_tag', playerTag)
      .select('player_tag')
      .single();

    if (updateError) {
      setError(updateError.message);
    } else {
      setAccounts((current) => current.map((account) =>
        account.player_tag === playerTag ? { ...account, war_weight: warWeight, owner } : account
      ));
      setMessage(`${playerTag} account details updated.`);
      cancelWeightEdit();
    }
    setUpdatingTag(null);
  };

  const handleEditKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, playerTag: string) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveWeight(playerTag);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelWeightEdit();
    }
  };

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-16 space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Database className="w-6 h-6 text-gold-400" />
            <h2 className="font-display text-2xl font-bold text-white">Filler Accounts</h2>
          </div>
          <p className="mt-1 text-sm text-astral-300/60">Track account ownership and clan placement.</p>
        </div>
        <div className="flex items-center gap-2 self-start md:self-auto">
          <button onClick={() => setShowAddAccount((current) => !current)} className="astral-btn-primary" title="Add account">
            <Plus className="w-4 h-4" /> Add account
          </button>
          <button onClick={() => void loadAccounts()} className="astral-btn-ghost" title="Refresh accounts">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {showAddAccount && (
        <form onSubmit={handleSubmit} className="astral-card p-5 md:ml-auto md:max-w-xl">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2 text-gold-300 font-medium"><Plus className="w-4 h-4" /> Add account</div>
            <button type="button" onClick={() => setShowAddAccount(false)} className="p-2 text-astral-300/70 hover:text-white rounded-lg" title="Close add account panel"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="text-sm text-astral-200">Player Tag <span className="text-rose-300">*</span>
              <input required maxLength={15} value={form.playerTag} onChange={(event) => setForm({ ...form, playerTag: normalizePlayerTag(event.target.value) })} placeholder="#PLAYER" className="astral-input mt-1.5 w-full uppercase" />
            </label>
            <label className="text-sm text-astral-200">Owner <span className="text-rose-300">*</span>
              <input required maxLength={50} value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value.toUpperCase() })} placeholder="OWNER NAME" className="astral-input mt-1.5 w-full uppercase" />
            </label>
          </div>
          <button type="submit" disabled={saving} className="astral-btn-primary mt-4">
            {saving ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add account
          </button>
        </form>
      )}

      <section className="astral-card overflow-hidden">
        <div className="p-4 border-b border-astral-700/30 flex flex-col lg:flex-row gap-3">
          <div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-astral-400" /><input value={playerFilter} onChange={(event) => setPlayerFilter(event.target.value.toUpperCase())} placeholder="Filter Player Tag" className="astral-input w-full pl-10 uppercase" /></div>
          <div className="relative flex-1"><Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-astral-400" /><input value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value.toUpperCase())} placeholder="Filter Owner" className="astral-input w-full pl-10 uppercase" /></div>
          <select value={clanFilter} onChange={(event) => setClanFilter(event.target.value)} className="astral-input lg:w-56">
            <option value="">All clans</option>
            <option value={AVAILABLE_FILTER}>Available</option>
            {clans.map((clan) => <option key={clan.clan_tag} value={clan.clan_tag}>{clan.clan_name}</option>)}
          </select>
          <select value={townHallFilter} onChange={(event) => setTownHallFilter(event.target.value)} className="astral-input lg:w-44">
            <option value="">All Town Halls</option>
            {townHallOptions.map((level) => <option key={level} value={level}>Town Hall {level}</option>)}
            <option value="none">No Town Hall</option>
          </select>
          {(playerFilter || ownerFilter || clanFilter || townHallFilter) && <button type="button" onClick={() => { setPlayerFilter(''); setOwnerFilter(''); setClanFilter(''); setTownHallFilter(''); }} className="astral-btn-ghost" title="Clear filters"><X className="w-4 h-4" /> Clear</button>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-space-700/40 text-left text-astral-300/70"><th className="px-4 py-3">Player Tag</th><th className="px-4 py-3">Player Name</th><th className="px-4 py-3"><button onClick={() => toggleSort('clan')} className="inline-flex items-center gap-1.5 hover:text-gold-300">Clan {sortIcon('clan')}</button></th><th className="px-4 py-3"><button onClick={() => toggleSort('townHall')} className="inline-flex items-center gap-1.5 hover:text-gold-300">Town Hall {sortIcon('townHall')}</button></th><th className="px-4 py-3">War Weight</th><th className="px-4 py-3"><button onClick={() => toggleSort('owner')} className="inline-flex items-center gap-1.5 hover:text-gold-300">Owner {sortIcon('owner')}</button></th><th className="px-4 py-3 text-right">Action</th></tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-astral-300/50"><LoaderCircle className="w-5 h-5 animate-spin mx-auto" /></td></tr>
              ) : sortedAccounts.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-astral-300/50">No accounts match the current filters.</td></tr>
              ) : sortedAccounts.map((account) => {
                const isEditing = editingTag === account.player_tag;
                const isUpdating = updatingTag === account.player_tag;
                return (
                  <tr key={account.player_tag} className="border-t border-astral-700/15 hover:bg-astral-700/10">
                    <td className="px-4 py-3 font-mono text-gold-300">{account.player_tag}</td>
                    <td className="px-4 py-3 text-astral-100">{account.player_name || '—'}</td>
                    <td className="px-4 py-3"><span className="text-astral-100">{account.clan_name}</span>{account.clan_tag && <span className="block text-xs text-astral-300/50">{account.clan_tag}</span>}</td>
                    <td className="px-4 py-3 text-astral-100">{account.town_hall ?? '—'}</td>
                    <td className="px-4 py-3 text-astral-100">{isEditing ? <input type="number" min="0" step="1" value={editingWeight} onChange={(event) => setEditingWeight(event.target.value)} onKeyDown={(event) => handleEditKeyDown(event, account.player_tag)} className="astral-input w-28 py-1.5" aria-label={`War weight for ${account.player_tag}`} /> : account.war_weight ?? '—'}</td>
                    <td className="px-4 py-3 text-astral-100">{isEditing ? <input maxLength={50} value={editingOwner} onChange={(event) => setEditingOwner(event.target.value.toUpperCase())} onKeyDown={(event) => handleEditKeyDown(event, account.player_tag)} className="astral-input w-36 py-1.5 uppercase" aria-label={`Owner for ${account.player_tag}`} /> : account.owner}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        {isEditing ? (
                          <>
                            <button type="button" onClick={() => void saveWeight(account.player_tag)} disabled={isUpdating} className="p-2 text-emerald-300/80 hover:text-emerald-200 hover:bg-emerald-500/10 rounded-lg" title="Save account details">
                              {isUpdating ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                            </button>
                            <button type="button" onClick={cancelWeightEdit} className="p-2 text-astral-300/70 hover:text-white hover:bg-astral-700/30 rounded-lg" title="Cancel edit"><X className="w-4 h-4" /></button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => startWeightEdit(account)} className="p-2 text-gold-300/70 hover:text-gold-200 hover:bg-gold-500/10 rounded-lg" title={`Edit account details for ${account.player_tag}`}><Edit2 className="w-4 h-4" /></button>
                            <button type="button" onClick={() => void handleDelete(account.player_tag)} disabled={deletingTag === account.player_tag} className="p-2 text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/10 rounded-lg" title={`Delete ${account.player_tag}`}><Trash2 className="w-4 h-4" /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-astral-700/20 text-xs text-astral-300/50">Showing {sortedAccounts.length} of {accounts.length} accounts</div>
      </section>
      {(error || message) && <div className={`p-4 rounded-xl border text-sm ${error ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'}`}>{error || message}</div>}
    </main>
  );
}