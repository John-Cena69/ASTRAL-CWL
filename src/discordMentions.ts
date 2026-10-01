import type { Clan, Player } from '@/types';

const MISSING_STATUSES = new Set(['In Home Clan', 'In Other Clan', 'In Wrong CWL Clan']);

interface MissingPlayer {
  clanName: string;
  player: Player;
}

function normalizeDiscordId(value: string): string {
  return value.trim().replace(/^<@!?/, '').replace(/>$/, '');
}

export function formatDiscordMention(discordId: string): string {
  const id = normalizeDiscordId(discordId);
  return id ? `<@${id}>` : '';
}

export function getMissingPlayers(clans: Clan[]): MissingPlayer[] {
  return clans.flatMap((clan) =>
    clan.players
      .filter((player) => MISSING_STATUSES.has(player.status) && player.discordId.trim())
      .map((player) => ({ clanName: clan.clanName, player }))
  );
}

export function buildClanMissingMentions(clan: Clan): string {
  return getMissingPlayers([clan])
    .map(({ player }) => {
      const mention = formatDiscordMention(player.discordId);
      return player.status === 'In Wrong CWL Clan'
        ? `${mention} (You're sitting in __WRONG__ CWL Clan)`
        : mention;
    })
    .join(' ');
}

export function buildAllMissingMentions(clans: Clan[]): string {
  const missingPlayers = getMissingPlayers(clans);
  const idsByPlayerName = new Map<string, Set<string>>();

  clans.flatMap((clan) => clan.players).forEach((player) => {
    const playerName = player.playerName.trim().toLowerCase();
    if (!playerName) return;
    const ids = idsByPlayerName.get(playerName) ?? new Set<string>();
    ids.add(normalizeDiscordId(player.discordId));
    idsByPlayerName.set(playerName, ids);
  });

  const entries = new Map<string, { player: Player; wrong: boolean }>();
  missingPlayers.forEach(({ player }) => {
    const id = normalizeDiscordId(player.discordId);
    const existing = entries.get(id);
    if (existing) {
      existing.wrong ||= player.status === 'In Wrong CWL Clan';
    } else {
      entries.set(id, { player, wrong: player.status === 'In Wrong CWL Clan' });
    }
  });

  return [...entries.values()]
    .map(({ player, wrong }) => {
      const playerName = player.playerName.trim();
      const ids = idsByPlayerName.get(playerName.toLowerCase());
      const nameSuffix = ids && ids.size > 1 && playerName ? `(${playerName})` : '';
      const mention = `${formatDiscordMention(player.discordId)}${nameSuffix}`;
      return wrong ? `${mention} (You're sitting in __WRONG__ CWL Clan)` : mention;
    })
    .join(' ');
}
