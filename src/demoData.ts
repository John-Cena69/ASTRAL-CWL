import type { Clan, Player } from '@/types';

const TH_LEVELS = [10, 11, 12, 13, 14, 14, 15, 15, 16, 16, 17];
const STATUSES = [
  'In CWL Clan',
  'In Wrong CWL Clan',
  'In Home Clan',
  'In Other Clan',
  'Unregistered',
  'In CWL Clan',
  'In Home Clan',
  'In CWL Clan',
];
const FIRST = ['Astro', 'Luna', 'Nova', 'Orion', 'Vega', 'Sirius', 'Lyra', 'Phoenix', 'Draco', 'Aurora', 'Zephyr', 'Atlas', 'Cosmo', 'Stella', 'Helios', 'Rigel'];
const LAST = ['Striker', 'Walker', 'Slayer', 'Guardian', 'Reaper', 'Crusher', 'Hunter', 'Blade', 'Storm', 'Fang', 'Shield', 'Crown', 'Flame', 'Shadow', 'Bolt', 'Edge'];

function pseudoRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function makeTag(rand: () => number): string {
  const chars = '0289CGJLPUVY';
  let tag = '#';
  for (let i = 0; i < 8; i++) {
    tag += chars[Math.floor(rand() * chars.length)];
  }
  return tag;
}

function makeDiscord(rand: () => number): string {
  const name = FIRST[Math.floor(rand() * FIRST.length)].toLowerCase();
  const num = Math.floor(rand() * 9000 + 1000);
  return `${name}.${num}`;
}

function makePlayers(count: number, seed: number, homeClan: string): Player[] {
  const rand = pseudoRandom(seed);
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    const first = FIRST[Math.floor(rand() * FIRST.length)];
    const last = LAST[Math.floor(rand() * LAST.length)];
    players.push({
      playerName: `${first} ${last}`,
      playerTag: makeTag(rand),
      discordId: makeDiscord(rand),
      townHall: TH_LEVELS[Math.floor(rand() * TH_LEVELS.length)],
      warWeight: Math.round((rand() * 60 + 80) * 10) / 10,
      homeClan,
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
    });
  }
  return players;
}

export function getDemoClans(): Clan[] {
  return [
    {
      clanName: 'Astral Titans',
      clanTag: '#2Y8G9P0V',
      players: makePlayers(15, 42, 'Astral Titans'),
    },
    {
      clanName: 'Golden Nebula',
      clanTag: '#8J2C5RQY',
      players: makePlayers(13, 137, 'Golden Nebula'),
    },
    {
      clanName: 'Cosmic Wardens',
      clanTag: '#P0L2V8G3',
      players: makePlayers(14, 256, 'Cosmic Wardens'),
    },
    {
      clanName: 'Stellar Reapers',
      clanTag: '#9V4C2J8L',
      players: makePlayers(12, 371, 'Stellar Reapers'),
    },
  ];
}
