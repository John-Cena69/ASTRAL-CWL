import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, Search, Users, X } from 'lucide-react';
import type { ClanRosterPlayer } from '@/types';

interface StrikePlayerPickerProps {
  clanName: string;
  roster: ClanRosterPlayer[];
  initialSelected: string[];
  pendingCounts: Map<string, number>;
  onClose: () => void;
  onDone: (players: ClanRosterPlayer[]) => void;
}

// Full-screen multi-select window for choosing strike recipients.
export default function StrikePlayerPicker({ clanName, roster, initialSelected, pendingCounts, onClose, onDone }: StrikePlayerPickerProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const searchRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    // Lock page scroll while open; compensate for the vanished scrollbar so nothing jumps.
    const { body, documentElement } = document;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      document.removeEventListener('keydown', onKey);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
    };
  }, []);

  const byTag = useMemo(() => new Map(roster.map((player) => [player.player_tag, player])), [roster]);
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const player of roster) {
      const key = player.player_name.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [roster]);

  const q = query.trim().toLowerCase().replace(/^#/, '');
  const visible = useMemo(
    () =>
      roster
        .filter(
          (player) =>
            !q ||
            player.player_name.toLowerCase().includes(q) ||
            player.player_tag.toLowerCase().replace(/^#/, '').includes(q) ||
            (player.discord_id ?? '').toLowerCase().includes(q)
        )
        .sort((a, b) => a.player_name.localeCompare(b.player_name, undefined, { sensitivity: 'base' })),
    [roster, q]
  );

  const selectedSet = new Set(selected);
  const allVisibleSelected = visible.length > 0 && visible.every((player) => selectedSet.has(player.player_tag));

  const toggle = (tag: string) =>
    setSelected((current) => (current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]));

  const toggleAllVisible = () =>
    setSelected((current) => {
      if (allVisibleSelected) {
        const hide = new Set(visible.map((player) => player.player_tag));
        return current.filter((tag) => !hide.has(tag));
      }
      const next = [...current];
      for (const player of visible) if (!next.includes(player.player_tag)) next.push(player.player_tag);
      return next;
    });

  const done = () => onDone(selected.map((tag) => byTag.get(tag)).filter((player): player is ClanRosterPlayer => !!player));

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Choose players">
      <div className="absolute inset-0 bg-space-950/75 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative flex flex-col w-full max-w-2xl max-h-[88vh] bg-space-800 border border-astral-700/30 rounded-2xl shadow-2xl shadow-space-950 overflow-hidden">
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-astral-700/20">
          <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center shrink-0">
            <Users className="w-5 h-5 text-rose-300" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-lg font-bold text-white truncate">Choose players to strike</h3>
            <p className="text-xs text-astral-300/60">{clanName} · {roster.length} player{roster.length === 1 ? '' : 's'} on the roster</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-astral-300/70 hover:text-white hover:bg-white/5 rounded-lg" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pt-4 space-y-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-astral-300/50" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && visible.length === 1) {
                  toggle(visible[0].player_tag);
                  setQuery('');
                }
              }}
              placeholder="Search by name, tag or Discord ID..."
              className="astral-input w-full pl-9 pr-9"
            />
            {query && (
              <button type="button" onClick={() => { setQuery(''); searchRef.current?.focus(); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-astral-300/60 hover:text-white rounded" aria-label="Clear search">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-astral-300/60">{visible.length} shown{q ? ' for this search' : ''}</span>
            <div className="flex items-center gap-3">
              <button type="button" onClick={toggleAllVisible} disabled={visible.length === 0} className="text-gold-300 hover:text-gold-200 disabled:text-astral-300/30">
                {allVisibleSelected ? `Deselect ${q ? 'shown' : 'all'}` : `Select ${q ? 'shown' : 'all'} (${visible.length})`}
              </button>
              {selected.length > 0 && (
                <button type="button" onClick={() => setSelected([])} className="text-astral-300/60 hover:text-white">Clear selection</button>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-[12rem] overflow-y-auto overscroll-contain px-3 py-3">
          {visible.length === 0 ? (
            <div className="py-12 text-center">
              <Users className="w-8 h-8 mx-auto text-astral-300/30" />
              <p className="mt-3 text-sm text-astral-300/60">{q ? 'No players match your search.' : 'No players on this roster.'}</p>
            </div>
          ) : (
            <ul className="space-y-1">
              {visible.map((player) => {
                const checked = selectedSet.has(player.player_tag);
                const pending = pendingCounts.get(player.player_tag) ?? 0;
                const duplicateName = (nameCounts.get(player.player_name.trim().toLowerCase()) ?? 0) > 1;
                return (
                  <li key={player.player_tag}>
                    <button
                      type="button"
                      onClick={() => toggle(player.player_tag)}
                      aria-pressed={checked}
                      className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition border ${checked ? 'border-gold-400/50 bg-gold-500/10' : 'border-transparent hover:bg-white/5'}`}
                    >
                      <span className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition ${checked ? 'border-gold-400 bg-gold-400 text-space-900' : 'border-astral-300/40'}`}>
                        {checked && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-sm font-medium text-white">{player.player_name}</span>
                        <span className="flex items-center gap-2 text-xs min-w-0">
                          <span className={`font-mono shrink-0 ${duplicateName ? 'text-gold-300 font-semibold' : 'text-gold-400/70'}`}>{player.player_tag}</span>
                          {player.discord_id && <span className="truncate text-astral-300/50">· {player.discord_id}</span>}
                        </span>
                      </span>
                      {pending > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[11px] text-amber-200 shrink-0" title="This player already has strikes waiting in the pending batch">
                          <AlertCircle className="w-3 h-3" /> {pending} pending
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-astral-700/20 bg-space-900/40 px-5 py-4 space-y-3">
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto overscroll-contain">
              {selected.map((tag) => {
                const player = byTag.get(tag);
                if (!player) return null;
                return (
                  <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-gold-400/30 bg-gold-500/10 pl-2.5 pr-1 py-0.5 text-xs text-gold-100">
                    {player.player_name}
                    <button type="button" onClick={() => toggle(tag)} className="p-0.5 rounded-full hover:bg-white/10" aria-label={`Remove ${player.player_name}`}>
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[8rem] text-sm text-white">
              <span className="font-semibold">{selected.length}</span> selected
            </div>
            <button type="button" onClick={onClose} className="astral-btn-ghost">Cancel</button>
            <button type="button" onClick={done} className="astral-btn-primary">
              <Check className="w-4 h-4" />
              {selected.length === 0 ? 'Done' : `Use ${selected.length} player${selected.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
