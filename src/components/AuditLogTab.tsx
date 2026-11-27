import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  Database,
  Download,
  Filter,
  Globe,
  History,
  Layers,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  Sparkles,
  Terminal,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { supabase } from '@/supabaseClient';
import type { TrackedClan } from '@/types';

export interface AuditLogEntry {
  id: number;
  occurred_at: string;
  table_name: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  row_pk: Record<string, unknown> | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  changed_fields: string[] | null;
  clan_tag: string | null;
  actor_discord_id: string | null;
  actor_name: string | null;
  actor_username: string | null;
  actor_role: string | null;
  actor_avatar_url: string | null;
  source: 'website' | 'website_direct' | 'external' | 'database';
  action: string | null;
  request_id: string | null;
  revert_of: number | null;
  reverted_at: string | null;
  reverted_by: string | null;
  reverted_by_log_id: number | null;
}

interface AuditActorFacet {
  id: string | null;
  name: string | null;
  username: string | null;
  role: string | null;
  avatar: string | null;
  source: string;
  count: number;
  last_seen: string;
}

interface AuditOverview {
  total: number;
  last_24h: number;
  last_7d: number;
  editors_7d: number;
  reverted: number;
  oldest: string | null;
  tables: { name: string; count: number }[];
  actors: AuditActorFacet[];
  clans: string[];
}

interface AuditLogTabProps {
  canRevert: boolean;
  knownClans?: TrackedClan[];
  onCountChange?: (total: number) => void;
}

/* ───────────────────── human-readable metadata ───────────────────── */

const TABLE_META: Record<
  string,
  { label: string; badge: string; category: string; summary: (entry: AuditLogEntry, clanLookup: Map<string, string>) => { title: string; target?: string; tag?: string } }
> = {
  allowed_user_ids: {
    label: 'Allowed Users',
    category: 'Access',
    badge: 'bg-violet-500/15 text-violet-200 border-violet-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const id = String(r.discord_user_id ?? '');
      const oldRole = e.old_data?.role;
      const newRole = e.new_data?.role;
      if (e.operation === 'INSERT') return { title: `Added user to allowlist as ${newRole ?? 'member'}`, target: id };
      if (e.operation === 'DELETE') return { title: `Removed user from allowlist (was ${oldRole ?? 'member'})`, target: id };
      return { title: `Changed user role from ${oldRole ?? '—'} → ${newRole ?? '—'}`, target: id };
    },
  },
  page_permissions: {
    label: 'Page Permissions',
    category: 'Access',
    badge: 'bg-violet-500/15 text-violet-200 border-violet-500/35',
    summary: (e, clans) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const role = String(r.role ?? '');
      const page = String(r.page_key ?? '');
      const scopeTag = String(r.clan_tag ?? '*');
      const scope = scopeTag === '*' ? 'All Clans' : clans.get(scopeTag) || scopeTag;
      const level = String(r.access_level ?? (r.allowed ? 'edit' : 'none'));
      if (e.operation === 'DELETE') return { title: `Cleared "${page}" permission rule`, target: `${role} · ${scope}` };
      return { title: `Set "${page}" access to ${level.toUpperCase()}`, target: `${role} · ${scope}` };
    },
  },
  family_clans: {
    label: 'Tracked Clans',
    category: 'Clans',
    badge: 'bg-gold-500/15 text-gold-200 border-gold-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const name = String(r.clan_name ?? '');
      const tag = String(r.clan_tag ?? '');
      const verb = e.operation === 'INSERT' ? 'Added tracked clan' : e.operation === 'DELETE' ? 'Removed tracked clan' : 'Updated tracked clan';
      return { title: verb, target: name || tag, tag: tag || undefined };
    },
  },
  clan_players: {
    label: 'Clan Roster',
    category: 'Roster',
    badge: 'bg-sky-500/15 text-sky-200 border-sky-500/35',
    summary: (e, clans) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const name = String(r.player_name ?? '');
      const tag = String(r.player_tag ?? '');
      const clanTag = String(r.clan_tag ?? '');
      const clan = clans.get(clanTag) || clanTag;
      if (e.operation === 'INSERT') return { title: `Added player to ${clan || 'clan'} roster`, target: name || tag, tag };
      if (e.operation === 'DELETE') return { title: `Removed player from ${clan || 'clan'} roster`, target: name || tag, tag };
      const fields = meaningfulChangedFields(e.changed_fields);
      return {
        title: `Updated roster player${clan ? ` in ${clan}` : ''} (${fields.map(prettyField).join(', ') || 'details'})`,
        target: name || tag,
        tag,
      };
    },
  },
  war_weights: {
    label: 'War Weights',
    category: 'Roster',
    badge: 'bg-cyan-500/15 text-cyan-200 border-cyan-500/35',
    summary: (e, clans) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const clanTag = String(r.clan_tag ?? e.clan_tag ?? '');
      const clan = String(r.clan_name ?? '') || clans.get(clanTag) || clanTag || 'clan';
      const actor = e.actor_name || e.actor_username || e.actor_discord_id || 'User';
      return {
        title: `${actor} updated War Weights for`,
        target: clan,
        tag: clanTag || undefined,
      };
    },
  },
  filler_accounts: {
    label: 'Filler Accounts',
    category: 'Fillers',
    badge: 'bg-teal-500/15 text-teal-200 border-teal-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const name = String(r.player_name ?? '');
      const tag = String(r.player_tag ?? '');
      const owner = String(r.owner ?? '');
      if (e.operation === 'INSERT') return { title: `Added filler account${owner ? ` (owner: ${owner})` : ''}`, target: name || tag, tag };
      if (e.operation === 'DELETE') return { title: `Removed filler account`, target: name || tag, tag };
      return { title: `Updated filler account`, target: name || tag, tag };
    },
  },
  bot_settings: {
    label: 'Bot & Sync Settings',
    category: 'Settings',
    badge: 'bg-amber-500/15 text-amber-200 border-amber-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const key = String(r.setting_key ?? '');
      const oldVal = e.old_data?.setting_value;
      const newVal = e.new_data?.setting_value;
      return {
        title: `Changed setting "${prettyField(key)}"`,
        target: `${oldVal ?? '—'} → ${newVal ?? '—'}`,
      };
    },
  },
  family_wars: {
    label: 'Family Wars',
    category: 'Wars',
    badge: 'bg-orange-500/15 text-orange-200 border-orange-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const clan = String(r.clan_name ?? r.clan_tag ?? '');
      const opp = String(r.opponent_name ?? r.opponent_tag ?? '');
      return { title: `${opVerb(e.operation)} war entry`, target: opp ? `${clan} vs ${opp}` : clan };
    },
  },
  cwl_seasons: {
    label: 'CWL Seasons',
    category: 'CWL',
    badge: 'bg-indigo-500/15 text-indigo-200 border-indigo-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const name = String(r.name ?? 'Season');
      if (e.operation === 'INSERT') return { title: `Opened CWL season`, target: name };
      if (e.old_data?.status !== e.new_data?.status) {
        return { title: `Season status ${e.old_data?.status ?? '—'} → ${e.new_data?.status ?? '—'}`, target: name };
      }
      if (e.old_data?.name !== e.new_data?.name) {
        return { title: `Renamed season "${e.old_data?.name}" → "${e.new_data?.name}"`, target: name };
      }
      return { title: `${opVerb(e.operation)} CWL season`, target: name };
    },
  },
  cwl_season_clans: {
    label: 'CWL Season Clans',
    category: 'CWL',
    badge: 'bg-indigo-500/15 text-indigo-200 border-indigo-500/35',
    summary: (e, clans) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const tag = String(r.clan_tag ?? '');
      const name = clans.get(tag) || tag;
      if (e.operation === 'INSERT') return { title: `Added clan to CWL season (${r.roster_size ?? 15}v${r.roster_size ?? 15})`, target: name, tag };
      if (e.new_data?.removed_at && !e.old_data?.removed_at) return { title: `Removed clan from CWL season`, target: name, tag };
      if (e.old_data?.roster_size !== e.new_data?.roster_size) {
        return { title: `Changed CWL roster size ${e.old_data?.roster_size}v → ${e.new_data?.roster_size}v`, target: name, tag };
      }
      return { title: `Updated CWL season clan`, target: name, tag };
    },
  },
  cwl_clans: {
    label: 'CWL Clans',
    category: 'CWL',
    badge: 'bg-indigo-500/15 text-indigo-200 border-indigo-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const name = String(r.clan_name ?? '');
      const tag = String(r.clan_tag ?? '');
      const league = String(r.cwl_league ?? '');
      return {
        title: `${opVerb(e.operation)} CWL clan${league ? ` (${league})` : ''}`,
        target: name || tag,
        tag,
      };
    },
  },
  cwl_entries: {
    label: 'CWL Entries',
    category: 'CWL',
    badge: 'bg-indigo-500/15 text-indigo-200 border-indigo-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const name = String(r.player_name ?? '');
      const tag = String(r.player_tag ?? '');
      if (e.operation === 'INSERT') return { title: `Added CWL signup entry`, target: name || tag, tag };
      if (e.operation === 'DELETE') return { title: `Deleted CWL signup entry`, target: name || tag, tag };
      const oldClan = e.old_data?.cwl_clan_name || e.old_data?.cwl_clan_tag;
      const newClan = e.new_data?.cwl_clan_name || e.new_data?.cwl_clan_tag;
      if (oldClan !== newClan) {
        if (!newClan) return { title: `Unassigned from CWL clan (${oldClan})`, target: name || tag, tag };
        if (!oldClan) return { title: `Assigned to CWL clan ${newClan}`, target: name || tag, tag };
        return { title: `Moved CWL assignment ${oldClan} → ${newClan}`, target: name || tag, tag };
      }
      return { title: `Updated CWL entry`, target: name || tag, tag };
    },
  },
  strikes_pending: {
    label: 'Pending Strikes',
    category: 'Strikes',
    badge: 'bg-amber-500/15 text-amber-200 border-amber-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const name = String(r.player_name ?? '');
      const tag = String(r.player_tag ?? '');
      const val = r.value ?? 0;
      const reason = String(r.reason ?? '');
      if (e.operation === 'INSERT') return { title: `Staged pending strike (${fmtStrikeVal(val)})${reason ? ` — ${reason}` : ''}`, target: name || tag, tag };
      if (e.operation === 'DELETE') return { title: `Cleared pending strike (${fmtStrikeVal(val)})`, target: name || tag, tag };
      return { title: `Edited pending strike (${fmtStrikeVal(val)})`, target: name || tag, tag };
    },
  },
  strikes_confirmed: {
    label: 'Confirmed Strikes',
    category: 'Strikes',
    badge: 'bg-rose-500/15 text-rose-200 border-rose-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const name = String(r.player_name ?? '');
      const tag = String(r.player_tag ?? '');
      const val = Number(r.value ?? 0);
      const reason = String(r.reason ?? '');
      if (e.operation === 'INSERT') {
        const label = val < 0 ? `Applied strike reduction (${fmtStrikeVal(val)})` : `Confirmed strike (${fmtStrikeVal(val)})`;
        return { title: `${label}${reason ? ` — ${reason}` : ''}`, target: name || tag, tag };
      }
      if (e.operation === 'DELETE') {
        return { title: `Resolved / removed strike (${fmtStrikeVal(val)})${reason ? ` — ${reason}` : ''}`, target: name || tag, tag };
      }
      if (e.old_data?.is_active === true && e.new_data?.is_active === false) {
        return { title: `Archived strike for season "${e.new_data?.season ?? '—'}"`, target: name || tag, tag };
      }
      return { title: `Edited confirmed strike (${fmtStrikeVal(val)})${reason ? ` — ${reason}` : ''}`, target: name || tag, tag };
    },
  },
  strikes_archive: {
    label: 'Strikes Archive',
    category: 'Strikes',
    badge: 'bg-rose-500/15 text-rose-200 border-rose-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const name = String(r.player_name ?? '');
      const tag = String(r.player_tag ?? '');
      const season = String(r.season ?? '');
      return { title: `${opVerb(e.operation)} archived strike${season ? ` (${season})` : ''}`, target: name || tag, tag };
    },
  },
  strike_reasons_global: {
    label: 'Global Strike Reasons',
    category: 'Strikes',
    badge: 'bg-rose-500/15 text-rose-200 border-rose-500/35',
    summary: (e) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      return {
        title: `${opVerb(e.operation)} global strike reason (${fmtStrikeVal(r.value)})`,
        target: String(r.reason_text ?? ''),
      };
    },
  },
  clan_strike_overrides: {
    label: 'Clan Strike Overrides',
    category: 'Strikes',
    badge: 'bg-rose-500/15 text-rose-200 border-rose-500/35',
    summary: (e, clans) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const clan = clans.get(String(r.clan_tag ?? '')) || String(r.clan_tag ?? '');
      return { title: `${opVerb(e.operation)} clan strike override`, target: clan };
    },
  },
  clan_strike_custom: {
    label: 'Clan Custom Strikes',
    category: 'Strikes',
    badge: 'bg-rose-500/15 text-rose-200 border-rose-500/35',
    summary: (e, clans) => {
      const r = (e.new_data ?? e.old_data ?? {}) as Record<string, unknown>;
      const clan = clans.get(String(r.clan_tag ?? '')) || String(r.clan_tag ?? '');
      return {
        title: `${opVerb(e.operation)} custom strike reason (${fmtStrikeVal(r.value)})`,
        target: `${r.reason_text ?? ''}${clan ? ` · ${clan}` : ''}`,
      };
    },
  },
};

const FIELD_LABELS: Record<string, string> = {
  id: 'ID',
  clan_tag: 'Clan Tag',
  clan_name: 'Clan Name',
  player_tag: 'Player Tag',
  player_name: 'Player Name',
  discord_id: 'Discord ID',
  discord_user_id: 'Discord User ID',
  role: 'Role',
  page_key: 'Page Key',
  access_level: 'Access Level',
  allowed: 'Allowed',
  town_hall: 'Town Hall',
  status: 'Status',
  join_date: 'Join Date',
  days_in_clan: 'Days in Clan',
  war_weight: 'War Weight',
  war_weight_override: 'Weight Override',
  owner: 'Owner',
  value: 'Strike Value',
  reason: 'Reason',
  reason_text: 'Reason Text',
  note: 'Note',
  notes: 'Notes',
  issued_date: 'Issued Date',
  issued_by: 'Issued By',
  confirmed_date: 'Confirmed Date',
  confirmed_by: 'Confirmed By',
  edited_by: 'Edited By',
  is_active: 'Active',
  season: 'Season',
  cwl_league: 'CWL League',
  leader_name: 'Leader',
  home_clan: 'Home Clan',
  cwl_clan_name: 'CWL Clan',
  cwl_clan_tag: 'CWL Clan Tag',
  cwl_assigned_at: 'Assigned At',
  current_clan: 'Current Clan',
  roster_size: 'Roster Size',
  role_id: 'Discord Role ID',
  setting_key: 'Setting Key',
  setting_value: 'Setting Value',
  created_at: 'Created At',
  created_date: 'Created Date',
  updated_at: 'Updated At',
  updated_date: 'Updated Date',
  updated_count: 'Updated Players',
};

const IGNORED_UPDATE_FIELDS = new Set(['updated_at', 'updated_date', 'status', 'town_hall']);

function meaningfulChangedFields(fields: string[] | null | undefined): string[] {
  return (fields ?? []).filter((f) => !IGNORED_UPDATE_FIELDS.has(f));
}

function isIgnoredNoOpUpdate(entry: AuditLogEntry): boolean {
  if (entry.operation !== 'UPDATE') return false;
  if (entry.table_name === 'war_weights') return false;
  const raw = entry.changed_fields ?? [];
  return raw.length > 0 && meaningfulChangedFields(raw).length === 0;
}

const CWL_CATEGORY_TABLES = new Set([
  'cwl_seasons',
  'cwl_season_clans',
  'cwl_clans',
  'cwl_entries',
]);

function isEntryRevertable(entry: AuditLogEntry): boolean {
  if (entry.reverted_at) return false;
  if (entry.table_name === 'war_weights') return false;
  if (!entry.row_pk || Object.keys(entry.row_pk).length === 0) return false;
  if (entry.operation === 'INSERT' || entry.operation === 'DELETE') return true;
  if (entry.operation === 'UPDATE') return CWL_CATEGORY_TABLES.has(entry.table_name);
  return false;
}

function prettyField(col: string): string {
  return FIELD_LABELS[col] || col.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function opVerb(op: AuditLogEntry['operation']): string {
  return op === 'INSERT' ? 'Added' : op === 'DELETE' ? 'Deleted' : 'Updated';
}

function fmtStrikeVal(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return String(v ?? '');
  return n > 0 ? `+${n}` : String(n);
}

function fmtWeight(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || v === null || v === undefined || v === '') return '—';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatExactTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function dayBucketLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Unknown Date';
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function formatValue(val: unknown, col?: string): string {
  if (val === null || val === undefined || val === '') return '∅ null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (col && (col === 'war_weight' || col === 'war_weight_override') && typeof val === 'number') {
    return `${val.toLocaleString()} (${fmtWeight(val)})`;
  }
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) {
    return formatExactTimestamp(val);
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function describeEntry(
  entry: AuditLogEntry,
  clanLookup: Map<string, string>
): { tableLabel: string; tableBadge: string; title: string; target?: string; tag?: string } {
  const meta = TABLE_META[entry.table_name];
  if (meta) {
    const s = meta.summary(entry, clanLookup);
    return { tableLabel: meta.label, tableBadge: meta.badge, ...s };
  }
  const row = (entry.new_data ?? entry.old_data ?? {}) as Record<string, unknown>;
  const target =
    String(row.player_name ?? row.clan_name ?? row.name ?? row.player_tag ?? row.clan_tag ?? row.id ?? '') || undefined;
  return {
    tableLabel: prettyField(entry.table_name),
    tableBadge: 'bg-astral-700/30 text-astral-200 border-astral-600/40',
    title: `${opVerb(entry.operation)} row in ${entry.table_name}`,
    target,
  };
}

function operationChip(op: AuditLogEntry['operation']): { label: string; cls: string; dot: string } {
  if (op === 'INSERT') {
    return {
      label: 'INSERT',
      cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35',
      dot: 'bg-emerald-400',
    };
  }
  if (op === 'DELETE') {
    return {
      label: 'DELETE',
      cls: 'bg-rose-500/15 text-rose-300 border-rose-500/35',
      dot: 'bg-rose-400',
    };
  }
  return {
    label: 'UPDATE',
    cls: 'bg-amber-500/15 text-amber-300 border-amber-500/35',
    dot: 'bg-amber-400',
  };
}

function sourceBadge(source: AuditLogEntry['source']): { label: string; cls: string; Icon: typeof Globe } {
  switch (source) {
    case 'website':
      return { label: 'Website API', cls: 'text-astral-200 bg-astral-700/25 border-astral-600/35', Icon: Globe };
    case 'website_direct':
      return { label: 'Website Session', cls: 'text-sky-200 bg-sky-500/15 border-sky-500/30', Icon: UserCheck };
    case 'external':
      return { label: 'External Service', cls: 'text-amber-200 bg-amber-500/15 border-amber-500/30', Icon: Terminal };
    default:
      return { label: 'SQL / Database', cls: 'text-violet-200 bg-violet-500/15 border-violet-500/30', Icon: Database };
  }
}

/* ───────────────────── Batch grouping ───────────────────── */

type DisplayItem =
  | { kind: 'single'; entry: AuditLogEntry }
  | {
      kind: 'batch';
      key: string;
      request_id: string;
      entries: AuditLogEntry[];
      representative: AuditLogEntry;
    };

function groupByBatch(logs: AuditLogEntry[], enabled: boolean): DisplayItem[] {
  if (!enabled) return logs.map((entry) => ({ kind: 'single', entry }));
  const items: DisplayItem[] = [];
  const byRequest = new Map<string, { index: number; entries: AuditLogEntry[] }>();

  for (const entry of logs) {
    // Collapse rows that share a request_id, table, and operation, or legacy war_weights updates for the same clan & actor
    const key =
      entry.table_name === 'war_weights'
        ? `war_weights:${entry.clan_tag ?? ''}:${entry.actor_discord_id ?? entry.actor_name ?? ''}:${entry.request_id ?? entry.occurred_at.slice(0, 16)}`
        : entry.request_id
          ? `${entry.request_id}:${entry.table_name}:${entry.operation}`
          : null;
    if (!key) {
      items.push({ kind: 'single', entry });
      continue;
    }
    const existing = byRequest.get(key);
    if (!existing) {
      const idx = items.length;
      const bucket = [entry];
      byRequest.set(key, { index: idx, entries: bucket });
      items.push({ kind: 'single', entry });
    } else {
      existing.entries.push(entry);
      if (entry.table_name === 'war_weights') {
        // Collapse legacy war_weights row logs into a single clean summary entry
        items[existing.index] = { kind: 'single', entry: existing.entries[0] };
      } else {
        items[existing.index] = {
          kind: 'batch',
          key,
          request_id: entry.request_id!,
          entries: existing.entries,
          representative: existing.entries[0],
        };
      }
    }
  }
  return items;
}

/* ───────────────────── Component ───────────────────── */

export default function AuditLogTab({ canRevert, knownClans = [], onCountChange }: AuditLogTabProps) {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [overview, setOverview] = useState<AuditOverview | null>(null);
  const [clans, setClans] = useState<TrackedClan[]>(knownClans);
  const [notInstalled, setNotInstalled] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Filters
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [tableFilter, setTableFilter] = useState('');
  const [opFilter, setOpFilter] = useState<'' | 'INSERT' | 'UPDATE' | 'DELETE'>('');
  const [actorFilter, setActorFilter] = useState('');
  const [clanFilter, setClanFilter] = useState('');
  const [revertedFilter, setRevertedFilter] = useState<'' | 'active' | 'only'>('');
  const [dateRange, setDateRange] = useState<'all' | '24h' | '7d' | '30d' | 'custom'>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [groupBatches, setGroupBatches] = useState(true);

  // Interactive UI state
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set());
  const [rawJsonIds, setRawJsonIds] = useState<Set<number>>(new Set());
  const [showAllFieldsIds, setShowAllFieldsIds] = useState<Set<number>>(new Set());
  const [openActorCardKey, setOpenActorCardKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [revertTarget, setRevertTarget] = useState<AuditLogEntry | null>(null);
  const [revertingId, setRevertingId] = useState<number | null>(null);

  const actorPopupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (knownClans.length > 0 && clans.length === 0) setClans(knownClans);
  }, [knownClans, clans.length]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchInput.trim()), 260);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    if (!openActorCardKey) return;
    const onDocClick = (e: MouseEvent) => {
      if (actorPopupRef.current && !actorPopupRef.current.contains(e.target as Node)) {
        setOpenActorCardKey(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [openActorCardKey]);

  const clanLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clans) {
      m.set(c.clan_tag, c.clan_name);
      m.set(`#${c.clan_tag.replace(/^#+/, '')}`, c.clan_name);
      m.set(c.clan_tag.replace(/^#+/, ''), c.clan_name);
    }
    return m;
  }, [clans]);

  const computeDateBounds = useCallback((): { from?: string; to?: string } => {
    const now = Date.now();
    if (dateRange === '24h') return { from: new Date(now - 24 * 3600 * 1000).toISOString() };
    if (dateRange === '7d') return { from: new Date(now - 7 * 24 * 3600 * 1000).toISOString() };
    if (dateRange === '30d') return { from: new Date(now - 30 * 24 * 3600 * 1000).toISOString() };
    if (dateRange === 'custom') {
      const from = customFrom ? new Date(`${customFrom}T00:00:00`).toISOString() : undefined;
      const to = customTo ? new Date(`${customTo}T23:59:59.999`).toISOString() : undefined;
      return { from, to };
    }
    return {};
  }, [dateRange, customFrom, customTo]);

  const fetchLogs = useCallback(
    async (opts?: { beforeId?: number; keepOverview?: boolean }) => {
      if (!supabase) {
        setError('Supabase is not configured.');
        setLoading(false);
        return;
      }
      const isLoadMore = Boolean(opts?.beforeId);
      if (isLoadMore) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      try {
        const { data: session } = await supabase.auth.getSession();
        const token = session.session?.access_token;
        const params = new URLSearchParams();
        params.set('limit', '60');
        if (opts?.beforeId) params.set('before_id', String(opts.beforeId));
        if (opts?.keepOverview) params.set('include_overview', '0');
        if (tableFilter) params.set('table', tableFilter);
        if (opFilter) params.set('operation', opFilter);
        if (actorFilter) params.set('actor', actorFilter);
        if (clanFilter) params.set('clan_tag', clanFilter);
        if (revertedFilter) params.set('reverted', revertedFilter);
        if (debouncedQuery) params.set('q', debouncedQuery);
        const { from, to } = computeDateBounds();
        if (from) params.set('from', from);
        if (to) params.set('to', to);

        const resp = await fetch(`/api/audit-log?${params.toString()}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const body = (await resp.json().catch(() => ({}))) as {
          ok?: boolean;
          not_installed?: boolean;
          logs?: AuditLogEntry[];
          total?: number;
          next_cursor?: number | null;
          overview?: AuditOverview;
          clans?: TrackedClan[];
          error?: string;
        };

        if (body.not_installed) {
          setNotInstalled(true);
          setLogs([]);
          setTotal(0);
          return;
        }
        if (!resp.ok || !body.ok) {
          throw new Error(body.error || `Failed to load audit log (HTTP ${resp.status}).`);
        }

        setNotInstalled(false);
        const rows = (body.logs ?? []).filter((r) => !isIgnoredNoOpUpdate(r));
        setLogs((prev) => (isLoadMore ? [...prev, ...rows] : rows));
        const nextTotal = body.total ?? rows.length;
        setTotal(nextTotal);
        setNextCursor(body.next_cursor ?? null);
        if (body.overview) {
          setOverview(body.overview);
          onCountChange?.(body.overview.total);
        } else if (!isLoadMore) {
          onCountChange?.(nextTotal);
        }
        if (Array.isArray(body.clans) && body.clans.length > 0) setClans(body.clans);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load audit log.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [tableFilter, opFilter, actorFilter, clanFilter, revertedFilter, debouncedQuery, computeDateBounds, onCountChange]
  );

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  const toggleSet = <T,>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const clearAllFilters = () => {
    setSearchInput('');
    setDebouncedQuery('');
    setTableFilter('');
    setOpFilter('');
    setActorFilter('');
    setClanFilter('');
    setRevertedFilter('');
    setDateRange('all');
    setCustomFrom('');
    setCustomTo('');
  };

  const hasActiveFilters = Boolean(
    debouncedQuery ||
      tableFilter ||
      opFilter ||
      actorFilter ||
      clanFilter ||
      revertedFilter ||
      dateRange !== 'all'
  );

  const executeRevert = async (entry: AuditLogEntry) => {
    if (!supabase) return;
    setRevertingId(entry.id);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const resp = await fetch('/api/audit-log', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ action: 'revert', id: entry.id }),
      });
      const body = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        reverted_id?: number;
        new_log_id?: number | null;
        error?: string;
      };
      if (!resp.ok || !body.ok) throw new Error(body.error || `Revert failed (HTTP ${resp.status}).`);
      setRevertTarget(null);
      setNotice(`Reverted change #${entry.id}${body.new_log_id ? ` (recorded as #${body.new_log_id})` : ''}.`);
      await fetchLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revert failed.');
    } finally {
      setRevertingId(null);
    }
  };

  const exportCsv = () => {
    if (logs.length === 0) return;
    const escape = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const headers = [
      'id',
      'occurred_at',
      'actor_name',
      'actor_username',
      'actor_discord_id',
      'actor_role',
      'source',
      'operation',
      'table_name',
      'clan_tag',
      'action',
      'summary',
      'changed_fields',
      'row_pk',
      'old_data',
      'new_data',
      'reverted_at',
      'reverted_by',
    ];
    const lines = [headers.join(',')];
    for (const l of logs) {
      const desc = describeEntry(l, clanLookup);
      const summary = `${desc.title}${desc.target ? ` (${desc.target})` : ''}`;
      lines.push(
        [
          l.id,
          l.occurred_at,
          l.actor_name,
          l.actor_username,
          l.actor_discord_id,
          l.actor_role,
          l.source,
          l.operation,
          l.table_name,
          l.clan_tag,
          l.action,
          summary,
          (l.changed_fields ?? []).join(';'),
          JSON.stringify(l.row_pk ?? {}),
          JSON.stringify(l.old_data ?? {}),
          JSON.stringify(l.new_data ?? {}),
          l.reverted_at,
          l.reverted_by,
        ]
          .map(escape)
          .join(',')
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `astral-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const displayItems = useMemo(() => groupByBatch(logs, groupBatches), [logs, groupBatches]);

  // Bucket display items by calendar day for clean timeline separators
  const dayBuckets = useMemo(() => {
    const groups: { label: string; items: DisplayItem[] }[] = [];
    for (const item of displayItems) {
      const iso = item.kind === 'single' ? item.entry.occurred_at : item.representative.occurred_at;
      const label = dayBucketLabel(iso);
      const last = groups[groups.length - 1];
      if (!last || last.label !== label) {
        groups.push({ label, items: [item] });
      } else {
        last.items.push(item);
      }
    }
    return groups;
  }, [displayItems]);

  /* ───────────────────── Render helpers ───────────────────── */

  const renderActorBadge = (entry: AuditLogEntry, keySuffix: string) => {
    const cardKey = `${entry.id}-${keySuffix}`;
    const isOpen = openActorCardKey === cardKey;
    const src = sourceBadge(entry.source);
    const SrcIcon = src.Icon;
    const displayName =
      entry.actor_name ||
      entry.actor_username ||
      entry.actor_discord_id ||
      (entry.source === 'database' ? 'Database' : 'External');

    if (!entry.actor_discord_id) {
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${src.cls}`}
          title={`Source: ${src.label}`}
        >
          <SrcIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate max-w-[160px]">{displayName}</span>
        </span>
      );
    }

    return (
      <div className="relative inline-block" ref={isOpen ? actorPopupRef : undefined}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpenActorCardKey(isOpen ? null : cardKey);
          }}
          className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-[#2b224c]/90 hover:bg-[#372b61] border border-astral-400/60 shadow-sm shadow-astral-950/60 transition cursor-pointer group"
          title="Click for Discord identity & quick filter"
        >
          {entry.actor_avatar_url ? (
            <img
              src={entry.actor_avatar_url}
              alt={displayName}
              className="w-4 h-4 rounded-full object-cover border border-astral-300/40 shrink-0"
            />
          ) : (
            <div className="w-4 h-4 rounded-full bg-astral-700 flex items-center justify-center shrink-0">
              <Sparkles className="w-2.5 h-2.5 text-astral-200" />
            </div>
          )}
          <span className="text-xs font-semibold text-[#c9cdfb] group-hover:text-white transition truncate max-w-[150px]">
            @{displayName}
          </span>
          {entry.actor_role && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-space-950/70 text-gold-300 font-medium">
              {entry.actor_role}
            </span>
          )}
        </button>

        {isOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute left-0 mt-2 w-72 z-30 rounded-2xl bg-space-800/95 backdrop-blur-xl border border-astral-500/50 p-4 shadow-2xl shadow-space-950 text-left"
          >
            <div className="flex items-start justify-between gap-3 pb-3 border-b border-astral-700/40">
              <div className="flex items-center gap-2.5 min-w-0">
                {entry.actor_avatar_url ? (
                  <img
                    src={entry.actor_avatar_url}
                    alt={displayName}
                    className="w-10 h-10 rounded-full object-cover border border-astral-400/60 shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-astral-700 flex items-center justify-center border border-astral-400/60 shrink-0">
                    <Sparkles className="w-4 h-4 text-gold-300" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white truncate">{displayName}</p>
                  {entry.actor_username && (
                    <p className="text-xs text-astral-300 truncate">@{entry.actor_username}</p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpenActorCardKey(null)}
                className="p-1 rounded-lg text-astral-300/60 hover:text-white hover:bg-astral-700/30"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-space-900/60">
                <span className="text-astral-300/70">Discord ID</span>
                <button
                  type="button"
                  onClick={() => void copyText(entry.actor_discord_id!, `actor-id-${cardKey}`)}
                  className="inline-flex items-center gap-1 font-mono text-astral-100 hover:text-gold-300"
                >
                  <span>{entry.actor_discord_id}</span>
                  {copiedKey === `actor-id-${cardKey}` ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3 opacity-60" />
                  )}
                </button>
              </div>
              {entry.actor_role && (
                <div className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-space-900/60">
                  <span className="text-astral-300/70">Role at Time</span>
                  <span className="font-semibold text-gold-300">{entry.actor_role}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-space-900/60">
                <span className="text-astral-300/70">Channel</span>
                <span className="text-astral-200">{src.label}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setActorFilter(entry.actor_discord_id!);
                setOpenActorCardKey(null);
              }}
              className="mt-3 w-full astral-btn-ghost justify-center text-xs py-1.5"
            >
              <Filter className="w-3.5 h-3.5" />
              Filter logs by @{displayName}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderInlineFieldPreview = (entry: AuditLogEntry) => {
    if (entry.table_name === 'war_weights') return null;
    if (entry.operation === 'UPDATE') {
      const cols = meaningfulChangedFields(entry.changed_fields);
      if (cols.length === 0) return null;
      const preview = cols.slice(0, 3);
      return (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {preview.map((col) => {
            const before = formatValue(entry.old_data?.[col], col);
            const after = formatValue(entry.new_data?.[col], col);
            return (
              <span
                key={col}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-space-950/70 border border-astral-700/35 text-[11px] max-w-full"
              >
                <span className="text-astral-300/70 font-medium">{prettyField(col)}:</span>
                <span className="font-mono text-rose-300/80 line-through truncate max-w-[130px]">{before}</span>
                <ArrowRight className="w-3 h-3 text-astral-300/50 shrink-0" />
                <span className="font-mono text-emerald-300 font-semibold truncate max-w-[150px]">{after}</span>
              </span>
            );
          })}
          {cols.length > 3 && (
            <span className="text-[11px] text-astral-300/60 px-1.5">+{cols.length - 3} more</span>
          )}
        </div>
      );
    }

    const snap = (entry.new_data ?? entry.old_data ?? {}) as Record<string, unknown>;
    const highlightCols = ['player_name', 'player_tag', 'clan_name', 'clan_tag', 'role', 'access_level', 'value', 'reason', 'war_weight', 'owner', 'cwl_league', 'setting_value'].filter(
      (c) => snap[c] !== undefined && snap[c] !== null && snap[c] !== ''
    );
    if (highlightCols.length === 0) return null;
    return (
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {highlightCols.slice(0, 4).map((col) => (
          <span
            key={col}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-space-950/60 border border-astral-700/30 text-[11px]"
          >
            <span className="text-astral-300/60">{prettyField(col)}:</span>
            <span className="font-mono text-astral-100 truncate max-w-[160px]">{formatValue(snap[col], col)}</span>
          </span>
        ))}
      </div>
    );
  };

  const renderDiffInspector = (entry: AuditLogEntry) => {
    const isRaw = rawJsonIds.has(entry.id);
    const showAll = showAllFieldsIds.has(entry.id);
    const oldObj = (entry.old_data ?? {}) as Record<string, unknown>;
    const newObj = (entry.new_data ?? {}) as Record<string, unknown>;
    const allKeys = Array.from(new Set([...Object.keys(oldObj), ...Object.keys(newObj)])).filter(
      (k) => !(entry.operation === 'UPDATE' && IGNORED_UPDATE_FIELDS.has(k))
    );
    const changedSet = new Set(meaningfulChangedFields(entry.changed_fields));
    const displayKeys =
      entry.operation === 'UPDATE' && !showAll
        ? allKeys.filter((k) => changedSet.has(k))
        : allKeys;

    const src = sourceBadge(entry.source);
    const clanName = entry.clan_tag ? clanLookup.get(entry.clan_tag) : null;

    return (
      <div className="border-t border-astral-700/30 bg-space-950/55 px-4 sm:px-5 py-4 space-y-4">
        {/* Metadata bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-astral-300/70">Log #{entry.id}</span>
            <span className="text-astral-300/30">·</span>
            <span className="text-astral-200">{formatExactTimestamp(entry.occurred_at)}</span>
            <span className="text-astral-300/30">·</span>
            <span className={`px-2 py-0.5 rounded border text-[11px] ${src.cls}`}>{src.label}</span>
            {entry.action && (
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-space-900 border border-astral-700/40 text-gold-300">
                {entry.action}
              </span>
            )}
            {entry.clan_tag && (
              <span className="text-[11px] px-2 py-0.5 rounded bg-space-900 border border-astral-700/40 text-astral-200">
                {clanName ? `${clanName} (${entry.clan_tag})` : entry.clan_tag}
              </span>
            )}
            {entry.row_pk && (
              <span className="font-mono text-[11px] text-astral-300/60">
                PK: {Object.entries(entry.row_pk).map(([k, v]) => `${k}=${String(v)}`).join(', ')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {entry.operation === 'UPDATE' && allKeys.length > changedSet.size && !isRaw && (
              <button
                type="button"
                onClick={() => toggleSet(setShowAllFieldsIds, entry.id)}
                className="px-2.5 py-1 rounded-lg text-xs bg-space-800 hover:bg-space-700 border border-astral-700/40 text-astral-200 transition"
              >
                {showAll ? `Changed only (${changedSet.size})` : `Show all ${allKeys.length} columns`}
              </button>
            )}
            <button
              type="button"
              onClick={() => toggleSet(setRawJsonIds, entry.id)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs border transition ${
                isRaw
                  ? 'bg-gold-400/15 border-gold-400/40 text-gold-200'
                  : 'bg-space-800 hover:bg-space-700 border-astral-700/40 text-astral-200'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              {isRaw ? 'Diff table' : 'Raw JSON'}
            </button>
            <button
              type="button"
              onClick={() =>
                void copyText(
                  JSON.stringify(
                    {
                      id: entry.id,
                      occurred_at: entry.occurred_at,
                      table: entry.table_name,
                      operation: entry.operation,
                      actor: {
                        discord_id: entry.actor_discord_id,
                        name: entry.actor_name,
                        username: entry.actor_username,
                        role: entry.actor_role,
                      },
                      row_pk: entry.row_pk,
                      changed_fields: entry.changed_fields,
                      old_data: entry.old_data,
                      new_data: entry.new_data,
                    },
                    null,
                    2
                  ),
                  `json-${entry.id}`
                )
              }
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs bg-space-800 hover:bg-space-700 border border-astral-700/40 text-astral-200 transition"
            >
              {copiedKey === `json-${entry.id}` ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy JSON
                </>
              )}
            </button>
            {canRevert && isEntryRevertable(entry) && (
              <button
                type="button"
                onClick={() => setRevertTarget(entry)}
                disabled={revertingId === entry.id}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-200 font-medium transition"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Revert change
              </button>
            )}
          </div>
        </div>

        {/* Diff table or Raw JSON */}
        {isRaw ? (
          <div className="grid md:grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl bg-space-900/90 border border-astral-700/35 p-3 overflow-x-auto">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-300/80 mb-1.5">
                Before (old_data)
              </p>
              <pre className="font-mono text-astral-200 whitespace-pre-wrap break-all">
                {entry.old_data ? JSON.stringify(entry.old_data, null, 2) : 'null'}
              </pre>
            </div>
            <div className="rounded-xl bg-space-900/90 border border-astral-700/35 p-3 overflow-x-auto">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300/80 mb-1.5">
                After (new_data)
              </p>
              <pre className="font-mono text-astral-200 whitespace-pre-wrap break-all">
                {entry.new_data ? JSON.stringify(entry.new_data, null, 2) : 'null'}
              </pre>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-astral-700/35 overflow-hidden bg-space-900/75">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-space-800/80 border-b border-astral-700/30 text-astral-300/70">
                  <th className="px-3.5 py-2 text-left font-semibold w-44">Field</th>
                  {entry.operation !== 'INSERT' && (
                    <th className="px-3.5 py-2 text-left font-semibold">Previous Value</th>
                  )}
                  {entry.operation !== 'DELETE' && (
                    <th className="px-3.5 py-2 text-left font-semibold">New Value</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-astral-700/20">
                {displayKeys.map((col) => {
                  const isChanged = entry.operation !== 'UPDATE' || changedSet.has(col);
                  const oldVal = formatValue(oldObj[col], col);
                  const newVal = formatValue(newObj[col], col);
                  return (
                    <tr
                      key={col}
                      className={isChanged ? 'bg-astral-900/15' : 'opacity-60'}
                    >
                      <td className="px-3.5 py-2 font-medium text-astral-200 align-top">
                        <div>{prettyField(col)}</div>
                        <div className="font-mono text-[10px] text-astral-300/50">{col}</div>
                      </td>
                      {entry.operation !== 'INSERT' && (
                        <td
                          className={`px-3.5 py-2 font-mono break-all align-top ${
                            entry.operation === 'DELETE' || isChanged
                              ? 'text-rose-200 bg-rose-500/5'
                              : 'text-astral-300/70'
                          }`}
                        >
                          {oldVal}
                        </td>
                      )}
                      {entry.operation !== 'DELETE' && (
                        <td
                          className={`px-3.5 py-2 font-mono break-all align-top ${
                            entry.operation === 'INSERT' || isChanged
                              ? 'text-emerald-200 bg-emerald-500/5 font-semibold'
                              : 'text-astral-300/70'
                          }`}
                        >
                          {newVal}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderEntryCard = (entry: AuditLogEntry, nested = false) => {
    const isSummaryOnly = entry.table_name === 'war_weights';
    const isExpanded = !isSummaryOnly && expandedIds.has(entry.id);
    const op = operationChip(entry.operation);
    const desc = describeEntry(entry, clanLookup);
    const clanName = entry.clan_tag ? clanLookup.get(entry.clan_tag) || entry.clan_tag : null;

    return (
      <div
        key={entry.id}
        className={`rounded-xl border transition overflow-hidden ${
          nested
            ? 'bg-space-900/60 border-astral-700/25'
            : 'bg-space-800/55 border-astral-700/35 hover:border-astral-600/50'
        } ${entry.reverted_at ? 'opacity-70' : ''}`}
      >
        <div
          onClick={isSummaryOnly ? undefined : () => toggleSet(setExpandedIds, entry.id)}
          className={`px-4 sm:px-5 py-3.5 select-none flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition ${
            isSummaryOnly ? '' : 'cursor-pointer hover:bg-astral-700/10'
          }`}
        >
          <div className="flex items-start gap-3 min-w-0 flex-1">
            {!isSummaryOnly && (
              <button
                type="button"
                aria-label={isExpanded ? 'Collapse log details' : 'Expand log details'}
                className="mt-1 p-0.5 rounded text-astral-300/60 hover:text-white shrink-0"
              >
                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            )}

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {renderActorBadge(entry, nested ? 'nested' : 'top')}

                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider border ${op.cls}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${op.dot}`} />
                  {op.label}
                </span>

                <span className={`px-2 py-0.5 rounded-md text-[11px] font-medium border ${desc.tableBadge}`}>
                  {desc.tableLabel}
                </span>

                {clanName && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-space-900/70 border border-astral-700/35 text-astral-200">
                    <Shield className="w-3 h-3 text-gold-400" />
                    {clanName}
                  </span>
                )}

                {entry.revert_of && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-amber-500/15 border border-amber-500/35 text-amber-200 font-medium">
                    <RotateCcw className="w-3 h-3" />
                    Revert of #{entry.revert_of}
                  </span>
                )}

                {entry.reverted_at && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-rose-500/15 border border-rose-500/35 text-rose-200">
                    Reverted by {entry.reverted_by || 'Developer'}
                  </span>
                )}
              </div>

              <p className={`mt-1.5 text-sm font-medium ${entry.reverted_at ? 'line-through text-astral-300/60' : 'text-astral-100'}`}>
                {desc.title}
                {desc.target && (
                  <span className="ml-1.5 font-semibold text-gold-300">{desc.target}</span>
                )}
                {desc.tag && desc.tag !== desc.target && (
                  <span className="ml-1.5 font-mono text-xs text-astral-300/70">
                    #{desc.tag.replace(/^#+/, '')}
                  </span>
                )}
              </p>

              {renderInlineFieldPreview(entry)}
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
            <div className="text-right">
              <div className="text-xs font-medium text-astral-200" title={formatExactTimestamp(entry.occurred_at)}>
                {formatRelativeTime(entry.occurred_at)}
              </div>
              <div className="text-[11px] font-mono text-astral-300/50">
                {new Date(entry.occurred_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
            </div>
            {canRevert && isEntryRevertable(entry) && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setRevertTarget(entry);
                }}
                disabled={revertingId === entry.id}
                className="p-1.5 rounded-lg text-amber-300/70 hover:text-amber-200 hover:bg-amber-500/15 transition"
                title={`Revert change #${entry.id}`}
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {isExpanded && renderDiffInspector(entry)}
      </div>
    );
  };

  const renderBatchCard = (batch: Extract<DisplayItem, { kind: 'batch' }>) => {
    const isOpen = expandedBatches.has(batch.key);
    const rep = batch.representative;
    const op = operationChip(rep.operation);
    const desc = describeEntry(rep, clanLookup);
    const clanName = rep.clan_tag ? clanLookup.get(rep.clan_tag) || rep.clan_tag : null;
    const sampleTargets = batch.entries
      .map((e) => describeEntry(e, clanLookup).target)
      .filter((t): t is string => Boolean(t));
    const uniqueTargets = Array.from(new Set(sampleTargets));

    return (
      <div
        key={batch.key}
        className="rounded-xl border border-gold-500/30 bg-space-800/60 overflow-hidden shadow-lg shadow-space-950/40"
      >
        <div
          onClick={() => toggleSet(setExpandedBatches, batch.key)}
          className="px-4 sm:px-5 py-3.5 cursor-pointer select-none flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-astral-700/10 transition"
        >
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <button
              type="button"
              aria-label={isOpen ? 'Collapse batch' : 'Expand batch'}
              className="mt-1 p-0.5 rounded text-gold-300 shrink-0"
            >
              {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {renderActorBadge(rep, 'batch')}
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-gold-500/15 border border-gold-400/40 text-gold-200">
                  <Layers className="w-3 h-3" />
                  {batch.entries.length} rows in batch
                </span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider border ${op.cls}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${op.dot}`} />
                  {op.label}
                </span>
                <span className={`px-2 py-0.5 rounded-md text-[11px] font-medium border ${desc.tableBadge}`}>
                  {desc.tableLabel}
                </span>
                {clanName && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-space-900/70 border border-astral-700/35 text-astral-200">
                    <Shield className="w-3 h-3 text-gold-400" />
                    {clanName}
                  </span>
                )}
              </div>

              <p className="mt-1.5 text-sm font-medium text-astral-100">
                {opVerb(rep.operation)} {batch.entries.length} {desc.tableLabel.toLowerCase()} records
                {rep.action && (
                  <span className="ml-2 font-mono text-xs text-astral-300/60">({rep.action})</span>
                )}
              </p>

              {uniqueTargets.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {uniqueTargets.slice(0, 6).map((t) => (
                    <span
                      key={t}
                      className="px-2 py-0.5 rounded-md bg-space-950/60 border border-astral-700/30 text-[11px] text-gold-300 font-medium"
                    >
                      {t}
                    </span>
                  ))}
                  {uniqueTargets.length > 6 && (
                    <span className="text-[11px] text-astral-300/60">+{uniqueTargets.length - 6} more</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="text-right self-end sm:self-center shrink-0">
            <div className="text-xs font-medium text-astral-200" title={formatExactTimestamp(rep.occurred_at)}>
              {formatRelativeTime(rep.occurred_at)}
            </div>
            <div className="text-[11px] text-gold-300/80">{isOpen ? 'Hide rows' : 'Inspect all rows'}</div>
          </div>
        </div>

        {isOpen && (
          <div className="border-t border-astral-700/30 bg-space-950/50 p-3 sm:p-4 space-y-2">
            {batch.entries.map((entry) => renderEntryCard(entry, true))}
          </div>
        )}
      </div>
    );
  };

  /* ───────────────────── Not-installed banner ───────────────────── */

  if (notInstalled) {
    return (
      <section className="astral-card p-6 sm:p-8 space-y-4">
        <div className="flex items-start gap-3.5">
          <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-500/35 flex items-center justify-center shrink-0">
            <Database className="w-5 h-5 text-amber-300" />
          </div>
          <div>
            <h3 className="font-display text-lg font-bold text-white">Enable Database Audit Logging</h3>
            <p className="text-sm text-astral-200/75 mt-1">
              Run <code className="px-1.5 py-0.5 rounded bg-space-950 text-gold-300 font-mono text-xs">supabase/audit-log.sql</code> once in your Supabase SQL Editor. It creates the <code className="font-mono text-xs text-astral-100">audit_log</code> table, attaches row-level triggers to every table, and schedules the 90-day retention purge.
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={() => void fetchLogs()} className="astral-btn-primary text-sm">
            <RefreshCw className="w-4 h-4" />
            Check Again
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      {/* === Overview KPI Strip === */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="astral-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-astral-500/15 border border-astral-500/35 flex items-center justify-center shrink-0">
            <History className="w-5 h-5 text-astral-300" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-astral-300/60">Logged Changes (90d)</p>
            <p className="text-xl font-bold text-white font-display">
              {(overview?.total ?? total).toLocaleString()}
            </p>
          </div>
        </div>

        <div className="astral-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/35 flex items-center justify-center shrink-0">
            <Activity className="w-5 h-5 text-emerald-300" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-astral-300/60">Last 24 Hours</p>
            <p className="text-xl font-bold text-emerald-300 font-display">
              {(overview?.last_24h ?? 0).toLocaleString()}
              <span className="ml-2 text-xs font-normal text-astral-300/60">
                ({(overview?.last_7d ?? 0).toLocaleString()} in 7d)
              </span>
            </p>
          </div>
        </div>

        <div className="astral-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-gold-500/15 border border-gold-500/35 flex items-center justify-center shrink-0">
            <UserCheck className="w-5 h-5 text-gold-300" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-astral-300/60">Active Editors (7d)</p>
            <p className="text-xl font-bold text-gold-300 font-display">
              {(overview?.editors_7d ?? 0).toLocaleString()}
            </p>
          </div>
        </div>

        <div className="astral-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/35 flex items-center justify-center shrink-0">
            <Clock className="w-5 h-5 text-amber-300" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-astral-300/60">Retention Window</p>
            <p className="text-sm font-bold text-white">
              90 Days
              <span className="block text-[11px] font-normal text-astral-300/60">
                {overview?.reverted ? `${overview.reverted} reverted` : 'Auto-purged daily'}
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* === Filter Bar === */}
      <section className="astral-card p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-col lg:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-astral-300/50 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search player name, #tag, Discord ID, @user, reason, or any field value..."
              className="astral-input w-full pl-10 pr-8 py-2 text-xs sm:text-sm"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-astral-300/60 hover:text-white"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Operation segmented pills */}
          <div className="inline-flex rounded-xl bg-space-950/80 p-1 border border-astral-700/35 self-start">
            {(
              [
                ['', 'All Ops', 'bg-astral-600/35 text-white border-astral-400/50'],
                ['INSERT', 'Added', 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'],
                ['UPDATE', 'Edited', 'bg-amber-500/20 text-amber-200 border-amber-500/40'],
                ['DELETE', 'Deleted', 'bg-rose-500/20 text-rose-200 border-rose-500/40'],
              ] as const
            ).map(([val, label, activeCls]) => {
              const active = opFilter === val;
              return (
                <button
                  key={val || 'ALL'}
                  type="button"
                  onClick={() => setOpFilter(val)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition ${
                    active ? activeCls : 'border-transparent text-astral-300/65 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Second row: dropdown filters + date range + actions */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* Table filter */}
            <select
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              className="astral-input text-xs py-1.5 px-2.5"
              aria-label="Filter by table"
            >
              <option value="">All Tables ({overview?.tables.length ?? Object.keys(TABLE_META).length})</option>
              {(overview?.tables?.length
                ? overview.tables
                : Object.keys(TABLE_META).map((name) => ({ name, count: 0 }))
              ).map((t) => (
                <option key={t.name} value={t.name}>
                  {TABLE_META[t.name]?.label ?? prettyField(t.name)}
                  {t.count ? ` (${t.count})` : ''}
                </option>
              ))}
            </select>

            {/* Actor filter */}
            <select
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
              className="astral-input text-xs py-1.5 px-2.5 max-w-[210px]"
              aria-label="Filter by user"
            >
              <option value="">All Users &amp; Sources</option>
              {(overview?.actors ?? []).map((a, idx) => {
                const val = a.id || `source:${a.source}`;
                const label = a.id
                  ? `@${a.name || a.username || a.id}${a.role ? ` (${a.role})` : ''}`
                  : a.name || a.source;
                return (
                  <option key={`${val}-${idx}`} value={val}>
                    {label} · {a.count}
                  </option>
                );
              })}
            </select>

            {/* Clan filter */}
            <select
              value={clanFilter}
              onChange={(e) => setClanFilter(e.target.value)}
              className="astral-input text-xs py-1.5 px-2.5"
              aria-label="Filter by clan"
            >
              <option value="">All Clans</option>
              {clans.map((c) => (
                <option key={c.clan_tag} value={c.clan_tag}>
                  {c.clan_name} ({c.clan_tag})
                </option>
              ))}
            </select>

            {/* Revert state filter */}
            <select
              value={revertedFilter}
              onChange={(e) => setRevertedFilter(e.target.value as '' | 'active' | 'only')}
              className="astral-input text-xs py-1.5 px-2.5"
              aria-label="Filter by revert status"
            >
              <option value="">All Statuses</option>
              <option value="active">Active (Not Reverted)</option>
              <option value="only">Reverted Only</option>
            </select>

            {/* Date range pills */}
            <div className="inline-flex items-center rounded-xl bg-space-950/75 p-0.5 border border-astral-700/35">
              {(
                [
                  ['all', '90d'],
                  ['24h', '24h'],
                  ['7d', '7d'],
                  ['30d', '30d'],
                  ['custom', 'Custom'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDateRange(key)}
                  className={`px-2 py-1 rounded-lg text-xs font-medium transition ${
                    dateRange === key
                      ? 'bg-gold-400/20 text-gold-200 border border-gold-400/40'
                      : 'text-astral-300/65 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs text-astral-300/80 cursor-pointer select-none px-2 py-1 rounded-lg hover:bg-space-900/60">
              <input
                type="checkbox"
                checked={groupBatches}
                onChange={(e) => setGroupBatches(e.target.checked)}
                className="rounded border-astral-600 bg-space-950 text-gold-400 focus:ring-gold-400/40"
              />
              Group batch actions
            </label>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-200 transition"
              >
                Reset filters
              </button>
            )}

            <button
              type="button"
              onClick={exportCsv}
              disabled={logs.length === 0}
              className="astral-btn-ghost text-xs py-1.5 px-2.5 disabled:opacity-40"
              title="Export currently loaded log entries to CSV"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>

            <button
              type="button"
              onClick={() => void fetchLogs()}
              className="astral-btn-ghost text-xs py-1.5 px-2.5"
              title="Refresh audit log"
            >
              {loading ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Refresh
            </button>
          </div>
        </div>

        {dateRange === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-astral-700/25 text-xs">
            <Calendar className="w-3.5 h-3.5 text-gold-300" />
            <span className="text-astral-300/70">From:</span>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="astral-input text-xs py-1 px-2"
            />
            <span className="text-astral-300/70">To:</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="astral-input text-xs py-1 px-2"
            />
          </div>
        )}
      </section>

      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <p className="text-sm flex-1">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="p-1 rounded-lg opacity-60 hover:opacity-100 hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {notice && !error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200">
          <Check className="w-5 h-5 shrink-0 mt-0.5" />
          <p className="text-sm flex-1">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="p-1 rounded-lg opacity-60 hover:opacity-100 hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* === Timeline Feed === */}
      {loading ? (
        <div className="astral-card p-12 text-center text-astral-300/60">
          <LoaderCircle className="w-6 h-6 animate-spin mx-auto" />
          <p className="mt-3 text-sm">Loading database audit trail...</p>
        </div>
      ) : dayBuckets.length === 0 ? (
        <div className="astral-card p-12 text-center space-y-2">
          <History className="w-8 h-8 mx-auto text-astral-300/40" />
          <p className="text-astral-100 font-medium">
            {hasActiveFilters ? 'No audit entries match your current filters.' : 'No database changes recorded yet.'}
          </p>
          <p className="text-xs text-astral-300/50">
            Every manual insert, edit, and deletion across the website and database will appear here with before/after diffs.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {dayBuckets.map((bucket) => (
            <section key={bucket.label} className="space-y-2.5">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold uppercase tracking-widest text-gold-300/90 px-2.5 py-1 rounded-lg bg-space-800/80 border border-astral-700/35">
                  {bucket.label}
                </span>
                <div className="h-px flex-1 bg-gradient-to-r from-astral-700/40 to-transparent" />
              </div>

              <div className="space-y-2.5">
                {bucket.items.map((item) =>
                  item.kind === 'single' ? renderEntryCard(item.entry) : renderBatchCard(item)
                )}
              </div>
            </section>
          ))}

          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2 text-xs text-astral-300/60">
            <span>
              Showing {logs.length.toLocaleString()} of {total.toLocaleString()} matching entries
            </span>
            {nextCursor && (
              <button
                type="button"
                onClick={() => void fetchLogs({ beforeId: nextCursor, keepOverview: true })}
                disabled={loadingMore}
                className="astral-btn-ghost text-xs"
              >
                {loadingMore ? (
                  <>
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                    Loading older entries...
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-4 h-4" />
                    Load older entries
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {/* === Revert Confirmation Modal (Developer only) === */}
      {revertTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm revert change"
        >
          <div
            className="absolute inset-0 bg-space-950/75 backdrop-blur-sm"
            onClick={() => !revertingId && setRevertTarget(null)}
            aria-hidden="true"
          />
          <div className="relative bg-space-800 border border-astral-600/45 rounded-2xl p-6 w-full max-w-lg shadow-2xl shadow-space-950 space-y-4">
            <div className="flex items-start gap-3.5">
              <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-500/35 flex items-center justify-center shrink-0">
                <RotateCcw className="w-5 h-5 text-amber-300" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-lg font-bold text-white">
                  Revert Database Change #{revertTarget.id}?
                </h3>
                <p className="text-xs text-astral-300/70 mt-0.5">
                  Table: <span className="font-mono text-astral-100">{revertTarget.table_name}</span> · Operation:{' '}
                  <span className="font-mono text-gold-300">{revertTarget.operation}</span>
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-space-950/70 border border-astral-700/35 p-3.5 text-xs space-y-2 max-h-60 overflow-y-auto">
              {revertTarget.operation === 'INSERT' && (
                <p className="text-rose-200 flex items-center gap-1.5">
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                  This row was inserted and will be <strong>DELETED</strong> by primary key{' '}
                  <code className="font-mono">{JSON.stringify(revertTarget.row_pk)}</code>.
                </p>
              )}
              {revertTarget.operation === 'DELETE' && (
                <p className="text-emerald-200">
                  This row was deleted and will be <strong>RE-INSERTED</strong> with its previous snapshot.
                </p>
              )}
              {revertTarget.operation === 'UPDATE' && (
                <div className="space-y-1.5">
                  <p className="text-astral-200">The following columns will be restored to their previous values:</p>
                  {(revertTarget.changed_fields ?? []).map((col) => (
                    <div key={col} className="flex items-center gap-2 font-mono text-[11px]">
                      <span className="text-astral-300/70">{col}:</span>
                      <span className="text-rose-300 line-through">
                        {formatValue(revertTarget.new_data?.[col], col)}
                      </span>
                      <ArrowRight className="w-3 h-3 text-astral-300/50" />
                      <span className="text-emerald-300 font-semibold">
                        {formatValue(revertTarget.old_data?.[col], col)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <p className="text-xs text-astral-300/60">
              The revert itself is recorded in the Audit Log and linked to entry #{revertTarget.id}.
            </p>

            <div className="flex justify-end gap-2.5 pt-1">
              <button
                type="button"
                disabled={revertingId === revertTarget.id}
                onClick={() => setRevertTarget(null)}
                className="astral-btn-ghost text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={revertingId === revertTarget.id}
                onClick={() => void executeRevert(revertTarget)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/45 text-amber-200 text-sm font-semibold transition"
              >
                {revertingId === revertTarget.id ? (
                  <LoaderCircle className="w-4 h-4 animate-spin" />
                ) : (
                  <RotateCcw className="w-4 h-4" />
                )}
                Confirm Revert
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
