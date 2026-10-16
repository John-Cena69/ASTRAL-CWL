// POST /api/sync-wars — replaces the bot's track_wars loop.
// Reads family_clans + bot_settings, fetches each clan's current war from
// the CoC API (via proxy, no static IP), and upserts family_wars.
// Auth: CRON_SECRET header or allowlisted user JWT.
import { CocMaintenance, getCurrentWar, PrivateWarLog, toUnixSeconds } from './_lib/coc.js';
import { adminClient, authorize } from './_lib/backend.js';
import { calculateFwaResult, getFwaPoints, lookupPoints } from './_lib/fwa.js';

const TOGGLE_CLAN = '#2C8PR82G';

function isFinalResult(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['win', 'won', 'victory', 'loss', 'lost', 'lose', 'defeat', 'tie'].some((word) =>
    normalized.includes(word)
  );
}

export async function syncWars(): Promise<{
  checked: number;
  upserted: number;
  skipped: number;
  skipDetail: string;
  syncFlipped: boolean;
  errors: string[];
}> {
  const supabase = adminClient();

  const [{ data: clanRows, error: clanError }, { data: settingRows, error: settingError }] =
    await Promise.all([
      supabase.from('family_clans').select('clan_tag'),
      supabase.from('bot_settings').select('setting_value').eq('setting_key', 'fwa_sync_state'),
    ]);
  if (clanError) throw new Error(clanError.message);
  if (settingError) throw new Error(settingError.message);

  const familyTags = (clanRows ?? []).map((row) => row.clan_tag as string);
  let syncState = settingRows?.[0]?.setting_value === 'Low' ? 'Low' : 'High';
  let syncFlipped = false;

  const points = await getFwaPoints(true);
  let checked = 0;
  let upserted = 0;
  let skipped = 0;
  let notInWar = 0;
  let privateLog = 0;
  let privateLogSample = '';
  const errors: string[] = [];

  for (const tag of familyTags) {
    checked++;
    let war;
    try {
      war = await getCurrentWar(tag);
    } catch (error) {
      if (error instanceof PrivateWarLog) {
        skipped++;
        privateLog++;
        if (!privateLogSample) privateLogSample = error.message.replace(/^\/clans\/[^:]+:\s*/, '').slice(0, 120);
        continue;
      }
      if (error instanceof CocMaintenance) return { checked, upserted, skipped, skipDetail: `notInWar=${notInWar} privateLog=${privateLog}${privateLogSample ? ` (${privateLogSample})` : ''}`, syncFlipped, errors };
      errors.push(`${tag}: ${(error as Error).message.slice(0, 160)}`);
      continue;
    }
    if (!war) {
      skipped++;
      notInWar++;
      continue;
    }

    const endTime = toUnixSeconds(war.endTime);
    const prepStart = toUnixSeconds(war.preparationStartTime);
    if (!endTime) {
      skipped++;
      continue;
    }

    try {
      await supabase.from('family_wars').delete().eq('clan_tag', tag).neq('end_time', endTime);
      const { data: existing, error: selectError } = await supabase
        .from('family_wars')
        .select('war_result')
        .eq('clan_tag', tag)
        .eq('end_time', endTime);
      if (selectError) throw new Error(selectError.message);

      const isNewWar = !existing || existing.length === 0;

      // Original bot flips the global sync once when the toggle clan's war
      // ends. Fixed here: only flip when no final result is stored yet
      // (the old code compared against "won"/"lost" but stores "Win"/"Loss",
      // so it flipped on EVERY poll while warEnded).
      if (tag.toUpperCase() === TOGGLE_CLAN && war.state === 'warEnded') {
        const alreadyFinal = !!existing?.[0] && isFinalResult(existing[0].war_result);
        if (!alreadyFinal) {
          syncState = syncState === 'High' ? 'Low' : 'High';
          syncFlipped = true;
          const { error: syncError } = await supabase
            .from('bot_settings')
            .update({ setting_value: syncState })
            .eq('setting_key', 'fwa_sync_state');
          if (syncError) throw new Error(syncError.message);
        }
      }

      const freshPoints = isNewWar ? await getFwaPoints(true) : points;
      const ourPoints = lookupPoints(freshPoints, war.clan.tag);
      const opponentPoints = lookupPoints(freshPoints, war.opponent.tag);
      const warResult = calculateFwaResult(
        ourPoints,
        opponentPoints,
        war.clan.tag,
        war.opponent.tag,
        syncState
      );

      const row = {
        clan_tag: tag,
        clan_badge_url:
          war.clan.badgeUrls?.medium ?? war.clan.badgeUrls?.large ?? war.clan.badgeUrls?.small ?? null,
        opponent_name: war.opponent.name,
        opponent_tag: war.opponent.tag,
        state: war.state,
        prep_start_time: prepStart,
        end_time: endTime,
        stars: war.clan.stars,
        attacks_used: war.clan.attacks,
        our_points: ourPoints,
        opponent_points: opponentPoints,
        sync_used: syncState,
        war_result: warResult,
        opponent_stars: war.opponent.stars,
        opponent_attacks_used: war.opponent.attacks,
      };

      if (isNewWar) {
        const { error: insertError } = await supabase.from('family_wars').insert(row);
        if (insertError) throw new Error(insertError.message);
      } else {
        const { error: updateError } = await supabase
          .from('family_wars')
          .update(row)
          .eq('clan_tag', tag)
          .eq('end_time', endTime);
        if (updateError) throw new Error(updateError.message);
      }
      upserted++;
    } catch (error) {
      errors.push(`${tag}: ${(error as Error).message.slice(0, 160)}`);
    }
  }

  return { checked, upserted, skipped, skipDetail: `notInWar=${notInWar} privateLog=${privateLog}${privateLogSample ? ` (${privateLogSample})` : ''}`, syncFlipped, errors: errors.slice(0, 10) };
}

export default async function handler(req: unknown, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): Promise<void> {
  const r = req as { method?: string; headers: Record<string, string | string[] | undefined> };
  if (r.method !== 'POST' && r.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Use POST.' });
    return;
  }
  const auth = await authorize(r);
  if (auth.ok === false) {
    res.status(401).json({ ok: false, error: auth.message });
    return;
  }
  try {
    const result = await syncWars();
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Sync failed.',
    });
  }
}
