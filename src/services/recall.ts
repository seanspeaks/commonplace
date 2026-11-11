import type { Actor, TierRank } from '../types.js';
import type { Knowledge } from './knowledge.js';

const MAX_TEXT = 3500;
const MAX_KEYWORDS = 24;

// Words that say nothing about which entity a prompt is about.
const STOP = new Set(
  `the and for are but not you all any can had her was one our out has him his how its may new now old see two way who did get got let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what into also then there their about would could should which these those where while after before being doing does done each every other because please thanks thank need help tell show give find look work make made using used want wants something anything everything nothing really still even back down same able file files code line lines function functions class method error errors test tests run running build change changes update add remove fix write read`.split(
    /\s+/,
  ),
);

export interface RecallHit {
  id: string;
  ref: string;
  name: string;
  tier: TierRank;
  ownerName: string;
  summary: string;
  facts: { tier: TierRank; content: string }[];
  brief: { text: string; authorityTier: TierRank } | null;
}

export function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]{2,39}/gu) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, MAX_KEYWORDS);
}

interface Candidate {
  id: string;
  type_key: string;
  name: string;
  aliases: string[];
  tier: TierRank;
  summary: string;
  owner_name: string;
  mentioned: boolean;
  score: number;
  haystack: string;
}

/**
 * Finds the few entities a piece of text is clearly about. Recall runs on every prompt, so it stays quiet
 * unless an entity is named outright or matches several of the text's keywords.
 */
export async function recall(k: Knowledge, actor: Actor, input: { text: string; via: 'tool' | 'hook'; limit?: number }): Promise<{ hits: RecallHit[]; text: string }> {
  const text = input.text.slice(0, 4000);
  const words = keywords(text);
  if (!words.length) return { hits: [], text: '' };
  const limit = input.limit ?? 5;

  const { rows } = await k.db.query<Candidate>(
    `with q as (select websearch_to_tsquery('english', $1) as tsq)
     select e.id, e.type_key, e.name, e.aliases, e.tier, e.summary, u.name as owner_name, m.mentioned,
       m.mentioned::int + ts_rank_cd(e.search, q.tsq) + coalesce(f.rank, 0) * 0.5 + coalesce(s.boost, 0) * 0.3 + (4 - e.tier) * 0.02 as score,
       lower(e.name || ' ' || array_to_string(e.aliases, ' ') || ' ' || e.summary || ' ' || coalesce(f.text, '')) as haystack
     from entities e cross join q
     join users u on u.id = e.owner_id
     left join entity_signals s on s.entity_id = e.id
     left join lateral (
       select max(ts_rank_cd(o.search, q.tsq)) as rank, string_agg(o.content, ' ') as text
       from observations o where o.entity_id = e.id and o.status = 'active' and o.search @@ q.tsq
     ) f on true
     cross join lateral (
       select exists (
         select 1 from unnest(array_append(e.aliases, e.name)) n
         where length(n) >= 3 and lower($2) ~ ('\\m' || regexp_replace(lower(n), '([.*+?^$(){}|\\[\\]\\\\])', '\\\\\\1', 'g') || '\\M')
       ) as mentioned
     ) m
     where e.status = 'active' and (m.mentioned or e.search @@ q.tsq or f.rank is not null)
     order by score desc limit 25`,
    [words.join(' OR '), text],
  );

  const needed = Math.min(2, words.length);
  const picked = rows.filter((c) => c.mentioned || words.filter((w) => c.haystack.includes(w)).length >= needed).slice(0, limit);
  if (!picked.length) return { hits: [], text: '' };
  const ids = picked.map((c) => c.id);

  const [facts, briefs] = await Promise.all([
    k.db.query<{ entity_id: string; tier: TierRank; content: string }>(
      `select entity_id, tier, content from (
         select o.entity_id, o.tier, o.content,
           row_number() over (partition by o.entity_id order by (o.search @@ websearch_to_tsquery('english', $2)) desc, o.tier, o.created_at desc) as n
         from observations o where o.entity_id = any($1) and o.status = 'active'
       ) ranked where n <= 3`,
      [ids, words.join(' OR ')],
    ),
    k.db.query<{ entity_id: string; brief: string; authority_tier: TierRank }>('select entity_id, brief, authority_tier from entity_briefs where entity_id = any($1)', [ids]),
  ]);

  const hits: RecallHit[] = picked.map((c) => {
    const b = briefs.rows.find((r) => r.entity_id === c.id);
    return {
      id: c.id,
      ref: `${c.type_key}:${c.name}`,
      name: c.name,
      tier: c.tier,
      ownerName: c.owner_name,
      summary: c.summary,
      facts: facts.rows.filter((f) => f.entity_id === c.id).map((f) => ({ tier: f.tier, content: f.content })),
      brief: b ? { text: b.brief, authorityTier: b.authority_tier } : null,
    };
  });

  await k.db.query('insert into recall_log (user_id, token_id, via, entity_ids) values ($1, $2, $3, $4)', [actor.userId, actor.tokenId || null, input.via, ids]);
  return { hits, text: formatRecall(k, hits) };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Plain text on purpose: Claude Code treats hook output that starts with "{" as a JSON control object. */
export function formatRecall(k: Knowledge, hits: RecallHit[]): string {
  if (!hits.length) return '';
  const lines = ['Commonplace has context on this. Tiers from most to least trusted: Canon, Verified, Working, Raw. Treat Raw as unreviewed.', ''];
  for (const h of hits) {
    lines.push(`- ${h.name} (${h.ref.split(':')[0]}, ${k.tierName(h.tier)}, owner ${h.ownerName})`);
    if (h.summary) lines.push(`  ${clip(h.summary, 300)}`);
    for (const f of h.facts) lines.push(`  - [${k.tierName(f.tier)}] ${clip(f.content, 280)}`);
    if (h.brief) lines.push(`  - Nightly digest, unreviewed, no more trusted than ${k.tierName(h.brief.authorityTier)}: ${clip(h.brief.text, 400)}`);
  }
  lines.push('', 'Use get_entity with the "type:name" ref for more. If something here is wrong, call request_update.');
  let out = lines.join('\n');
  while (out.length > MAX_TEXT && hits.length > 1) out = formatRecall(k, (hits = hits.slice(0, -1)));
  return clip(out, MAX_TEXT);
}
