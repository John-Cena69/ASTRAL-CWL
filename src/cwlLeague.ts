// Shared CWL league ordering (used by the Dashboard and the Roster page).
// Sort: Unranked first, then Legend, Champion 1 -> 2 -> 3, Titan, Master,
// Crystal, Gold, Silver, Bronze. In-game League I is the highest of a tier.
const TIER_ORDER: Record<string, number> = {
  legend: 0,
  champion: 1,
  titan: 2,
  master: 3,
  crystal: 4,
  gold: 5,
  silver: 6,
  bronze: 7,
};
const NUMERAL_ORDER: Record<string, number> = { i: 0, ii: 1, iii: 2 };

export function leagueRank(league: string | null): number {
  if (!league || league.trim().toLowerCase().includes('unrank')) return -1;
  const lower = league.trim().toLowerCase();
  if (lower.includes('legend')) return TIER_ORDER.legend;
  const base = Object.keys(TIER_ORDER).find((tier) => tier !== 'legend' && lower.includes(tier));
  if (!base) return 999;
  const numeral = lower.match(/\b(i{1,3})$/);
  const numeralRank = numeral ? NUMERAL_ORDER[numeral[1]] ?? 3 : 3;
  return TIER_ORDER[base] * 10 + numeralRank;
}

export function compareClansByLeague(
  a: { cwl_league: string | null; clan_name: string | null },
  b: { cwl_league: string | null; clan_name: string | null }
): number {
  return leagueRank(a.cwl_league) - leagueRank(b.cwl_league) || (a.clan_name ?? '').localeCompare(b.clan_name ?? '');
}
