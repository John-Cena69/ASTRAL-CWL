import { Database, Flag, Shield, Swords, X } from 'lucide-react';
import type { PageKey } from '@/types';

interface SidebarItem {
  key: PageKey;
  label: string;
  icon: typeof Shield;
}

interface SidebarSection {
  title: string;
  items: SidebarItem[];
}

// Add future pages here: push a new item into a section (or a new section),
// add its key to PageKey in src/types.ts, and render it in App.tsx.
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
  activePage: PageKey;
  onNavigate: (page: PageKey) => void;
  onClose: () => void;
}

export default function Sidebar({ open, activePage, onNavigate, onClose }: SidebarProps) {
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
                      onClick={() => onNavigate(item.key)}
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
        </nav>
      </aside>
    </>
  );
}
