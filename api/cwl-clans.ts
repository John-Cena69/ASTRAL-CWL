// /api/cwl-clans — CWL clans directory.
// POST   { clan_tag }    -> fetches the clan from the CoC API (name, league,
//          leader, badge) and upserts it into cwl_clans. Re-adding refreshes.
// POST   { refresh_all }   -> re-fetches every stored clan from the CoC API.
// DELETE { clan_tag } -> removes the row.
// Auth: CRON_SECRET header or allowlisted user JWT.
import { CocNotFound, getClan, type CocClan } from './_lib/coc.js';
import { adminClient, authorize, readJsonBody } from './_lib/backend.js';

function normalizeTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim().toUpperCase().replace(/^#+/, '');
  if (!/^[0289CGJLPUVQRY]+$/.test(clean) || clean.length < 3) return null;
  return `#${clean}`;
}

function buildRow(clan: CocClan) {
  const leader = clan.memberList?.find((m) => m.role === 'leader') ?? null;
  return {
    clan_tag: clan.tag,
    clan_name: clan.name,
    cwl_league: clan.warLeague?.name ?? null,
    leader_name: leader?.name ?? null,
    badge_url: clan.badgeUrls?.large ?? clan.badgeUrls?.medium ?? clan.badgeUrls?.small ?? null,
  };
}

export default async function handler(req: unknown, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): Promise<void> {
  const r = req as {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
  };
  if (r.method !== 'POST' && r.method !== 'DELETE') {
    res.status(405).json({ ok: false, error: 'Use POST to add, DELETE to remove.' });
    return;
  }
  const auth = await authorize(r);
  if (auth.ok === false) {
    res.status(401).json({ ok: false, error: auth.message });
    return;
  }

  const body = readJsonBody(r);
  if (r.method === 'POST' && body.refresh_all === true) {
    try {
      const supabase = adminClient();
      const { data: rows, error: selectError } = await supabase
        .from('cwl_clans')
        .select('clan_tag');
      if (selectError) throw new Error(selectError.message);
      const tags = (rows ?? []).map((row) => row.clan_tag as string);
      let refreshed = 0;
      const errors: string[] = [];
      for (const clanTag of tags) {
        try {
          const clan = await getClan(clanTag);
          const { error: upsertError } = await supabase
            .from('cwl_clans')
            .upsert(buildRow(clan), { onConflict: 'clan_tag' });
          if (upsertError) throw new Error(upsertError.message);
          refreshed++;
        } catch (error) {
          if (errors.length < 10) {
            errors.push(`${clanTag}: ${(error as Error).message.slice(0, 120)}`);
          }
        }
      }
      res.status(200).json({ ok: true, refreshed, total: tags.length, errors });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Refresh failed.',
      });
    }
    return;
  }

  const tag = normalizeTag(body.clan_tag);
  if (!tag) {
    res.status(400).json({ ok: false, error: 'Provide a valid clan tag.' });
    return;
  }

  try {
    const supabase = adminClient();
    if (r.method === 'DELETE') {
      const { error } = await supabase.from('cwl_clans').delete().eq('clan_tag', tag);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, deleted: tag });
      return;
    }

    let clan;
    try {
      clan = await getClan(tag);
    } catch (error) {
      if (error instanceof CocNotFound) {
        res.status(404).json({ ok: false, error: `No clan found for ${tag}. Check the tag.` });
        return;
      }
      throw error;
    }

    const row = buildRow(clan);
    const { error: upsertError } = await supabase
      .from('cwl_clans')
      .upsert(row, { onConflict: 'clan_tag' });
    if (upsertError) throw new Error(upsertError.message);
    res.status(200).json({ ok: true, clan: row });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Request failed.',
    });
  }
}
