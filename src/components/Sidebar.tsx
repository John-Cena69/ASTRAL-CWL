import { useEffect, useState } from 'react';
import {
  Database,
  Flag,
  Shield,
  Swords,
  X,
  Settings,
  Users,
} from 'lucide-react';
import type { PageKey, TrackedClan, ClanPage } from '@/types';
import { clanPageKey } from '@/types';
import { supabase } from '@/supabaseClient';

interface SidebarItem {
  key: PageKey | string;
  label: string;
  icon: typeof Shield;
}

interface SidebarSection {
  title: string;
  items: SidebarItem[];
}

interface ClanSection {
  title: string;
  clanTag: string;
  items: {
    key: string;
    label: string;
    page: 'home' | 'war-weights';
  }[];
}

export const SIDEBAR_SECTIONS: SidebarSection[] = [
  { title: 'CWL', items: [
    { key: 'roster', label: 'Roster', icon: Shield },
    { key: 'clans', label: 'Clans', icon: Flag },
  ] },
  { title: 'Fillers', items: [{ key: 'accounts', label: 'Accounts', icon: Database }] },
  { title: 'Wars', items: [{ key: 'wars', label: 'Wars', icon: Swords }] },
];

interface SidebarProps {
  open: boolean;
  activePage: PageKey | ClanPage;
  onNavigate: (page: PageKey | ClanPage) => void;
  onClose: () => void;
}

export default function Sidebar({ open, activePage, onNavigate, onClose }: SidebarProps) {
  const [trackedClans, setTrackedClans] = useState<TrackedClan[]>([]);
  const [loading, setLoading] = useState(true);

  const isClanPageActive = (page: PageKey | ClanPage): page is ClanPage => {
    return (page as ClanPage).type === 'clan';
  };

  const activeClanPage = isClanPageActive(activePage) ? activePage : null;

  useEffect(() => {
    let active = true;
    const loadClans = async () => {
      if (!supabase) {
        setLoading(false);
        return;
      }
      try {
        // Try the API route first (works under vercel dev / deployed)
        const response = await fetch('/api/tracked-clans', {
          headers: {
            ...(supabase.auth?.getSession
              ? { Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token ?? ''}` }
              : {}),
          },
        });
        if (response.ok) {
          const body = await response.json();
          if (active && body.ok) setTrackedClans(body.clans ?? []);
        }
      } catch {
        // Fall back to direct Supabase read
        try {
          const { data } = await supabase.from('tracked_clans').select('clan_tag, clan_name').order('clan_name');
          if (active) setTrackedClans(data ?? []);
        } catch {
          // Ignore
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    loadClans();
    return () => { active = false; };
  }, [supabase]);

  const buildClanSections = (): ClanSection[] => {
    return trackedClans.map((clan) => ({
      title: clan.clan_name,
      clanTag: clan.clan_tag,
      items: [
        { key: `clan-home:${clan.clan_tag}`, label: 'Home', page: 'home' },
        { key: `clan-weights:${clan.clan_tag}`, label: 'War Weights', page: 'war-weights' },
      ],
    }));
  };

  const clanSections = buildClanSections();

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-space-950/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 transform border-r border-astral-700/20 bg-space-900/95 backdrop-blur-md transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Site navigation"
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between px-4 py-5 border-b border-astral-700/20">
          <p className="font-display text-sm font-bold gold-text tracking-wide">NAVIGATION</p>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-astral-300/60 hover:text-white hover:bg-astral-700/30 transition"
            title="Close menu"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <nav className="p-3 space-y-5 overflow-y-auto">
          {SIDEBAR_SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-widest text-astral-300/40">
                {section.title}
              </p>
              <div className="space-y-1">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active = activePage === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => onNavigate(item.key as PageKey)}
                      className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium transition ${
                        active
                          ? 'bg-gold-500/15 text-gold-300 border border-gold-400/30'
                          : 'text-astral-200 border border-transparent hover:bg-astral-700/20 hover:text-white'
                      }`}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon className="w-4 h-4" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Dynamic clan sections */}
          {!loading && trackedClans.length > 0 && (
            <>
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-widest text-astral-300/40">
                Clans
              </p>
              <div className="space-y-1">
                {clanSections.map((section) => {
                  const activeHome = activeClanPage?.clanTag === section.clanTag && activeClanPage.page === 'home';
                  const activeWeights = activeClanPage?.clanTag === section.clanTag && activeClanPage.page === 'war-weights';
                  const isActive = activeHome || activeWeights;
                  return (
                    <div key={section.clanTag} className="mb-1">
                      <div className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium transition border bg-space-800/40 border-astral-700/30">
                        <Shield className="w-4 h-4 text-astral-400" />
                        <span className="text-astral-200 truncate">{section.title}</span>
                      </div>
                      <div className="space-y-0.5 ml-4">
                        {section.items.map((item) => {
                          const active = activeHome && item.page === 'home' ? true : activeWeights && item.page === 'war-weights' ? true : false;
                          const page: ClanPage = clanPageKey(section.clanTag, section.title, item.page);
                          return (
                            <button
                              key={item.key}
                              onClick={() => onNavigate(page)}
                              className={`flex items-center gap-2 w-full px-4 py-2 rounded-lg text-xs font-medium transition ${
                                active
                                  ? 'bg-gold-500/15 text-gold-300'
                                  : 'text-astral-300/60 hover:text-white hover:bg-astral-700/20'
                              }`}
                            >
                              <span className="w-2 h-2 rounded-full {active ? 'bg-gold-400' : 'bg-transparent'}"></span>
                              {item.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {loading && (
            <div className="px-3 py-2 text-xs text-astral-300/40">Loading clans...</div>
          )}
        </nav>

        {/* Developer section (only if Developer role) */}
        <div className="px-3 pb-4 border-t border-astral-700/30 mt-auto">
          <button
            onClick={() => onNavigate('clans')}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium text-astral-300/60 hover:text-white hover:bg-astral-700/20 transition"
          >
            <Settings className="w-4 h-4" />
            <span>Clan Management</span>
          </button>
        </div>
      </aside>
    </>
  );
}
