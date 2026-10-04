import { sql } from 'drizzle-orm';
import { withUser, type Database, type Transaction } from '@personalspace/db';
import { documentText } from '@personalspace/editor-schema';
import {
  searchQuerySchema,
  searchTokens,
  searchableTypes,
  transliterate,
  type RecordItem,
  type SearchQuery,
  type SearchResponse,
} from '@personalspace/validation';
import { recordsFor } from './capture.repository';

export async function indexSearchRecords(
  tx: Transaction,
  userId: string,
  ids: string[],
  records: RecordItem[],
) {
  if (!ids.length) return;
  await tx.execute(
    sql`DELETE FROM search_documents WHERE user_id = ${userId} AND entity_id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  for (const record of records) {
    if (
      record.deletedAt ||
      record.type === 'folder' ||
      record.type === 'attachment' ||
      (record.type === 'inbox' && record.status !== 'new')
    )
      continue;
    const title =
      record.type === 'note' || record.type === 'inbox'
        ? record.text.split('\n')[0]!.slice(0, 120)
        : record.text;
    const body =
      record.type === 'task'
        ? record.descriptionJson
          ? documentText(record.descriptionJson)
          : ''
        : record.type === 'learning_resource'
          ? record.description || ''
          : record.text;
    const extraParts = [...record.tags];
    if (record.type === 'transaction') {
      if (record.merchant) extraParts.push(record.merchant);
      if (record.amountMinor) extraParts.push((record.amountMinor / 100).toString());
    } else if (record.type === 'person') {
      if (record.nickname) extraParts.push(record.nickname);
      if (record.personNote) extraParts.push(record.personNote);
    } else if (record.type === 'learning_resource') {
      if (record.author) extraParts.push(record.author);
      if (record.url) extraParts.push(record.url);
    }
    const extra = extraParts.join(' ');
    // Transliterated mirror of all searchable text, folded into a shared
    // romanised space so Hinglish and Devanagari spellings match each other.
    const translit = transliterate(`${title} ${body} ${extra}`);
    await tx.execute(sql`INSERT INTO search_documents (entity_id,user_id,type,title,body,extra,title_normalized,document,translit,status,archived,project_id,folder_id,created_at,updated_at)
      VALUES (${record.id},${userId},${record.type},${title},${body},${extra},lower(unaccent(${title})),
        setweight(to_tsvector('simple',unaccent(${title})),'A') || setweight(to_tsvector('simple',unaccent(${body})),'B') || setweight(to_tsvector('simple',unaccent(${extra})),'C'),
        to_tsvector('simple',${translit}),
        ${record.status},${!!record.archivedAt || record.status === 'archived'},${record.projectId},${record.folderId},${record.createdAt},${record.updatedAt})`);
  }
}

export function createSearchService(db: Database) {
  return {
    search: async (userId: string, raw: SearchQuery): Promise<SearchResponse> => {
      const query = searchQuerySchema.parse(raw);
      const tokens = searchTokens(query.q);
      if (!tokens.length) return { groups: [] };
      const types = query.type ? [query.type] : searchableTypes;
      // Words are individually quoted before passing them to the tsquery parser.
      const prefixExpression = (words: string[]) =>
        words.map((word) => `'${word.replaceAll("'", "''")}':*`).join(' & ');
      const expression = prefixExpression(tokens);
      // Transliterated query terms let a Hinglish or Devanagari query match the
      // romanised `translit` vector regardless of the script the record used.
      const translitTokens = transliterate(query.q).split(' ').filter(Boolean);
      const translitExpression = translitTokens.length ? prefixExpression(translitTokens) : null;
      return withUser(
        db,
        userId,
        async (tx) => {
          const groups: SearchResponse['groups'] = [];
          for (const type of types) {
            const predicates = [sql`s.user_id = ${userId}`, sql`s.type = ${type}`];
            if (!query.includeArchived) predicates.push(sql`NOT s.archived`);
            if (query.tag) predicates.push(sql`${query.tag.toLowerCase()} = ANY(e.tags)`);
            if (query.projectId) predicates.push(sql`s.project_id = ${query.projectId}`);
            if (query.folderId) predicates.push(sql`s.folder_id = ${query.folderId}`);
            if (query.from)
              predicates.push(sql`s.created_at >= ${query.from}::date AT TIME ZONE 'UTC'`);
            if (query.to)
              predicates.push(sql`s.created_at < (${query.to}::date + 1) AT TIME ZONE 'UTC'`);
            if (query.status) predicates.push(sql`s.status = ${query.status}`);
            const translitMatch = translitExpression
              ? sql` OR s.translit @@ to_tsquery('simple', ${translitExpression})`
              : sql``;
            const result = await tx.execute<{ entity_id: string }>(sql`
          WITH query AS (SELECT to_tsquery('simple', unaccent(${expression})) AS terms, lower(unaccent(${tokens.join(' ')})) AS text)
          SELECT s.entity_id FROM search_documents s JOIN entities e ON e.id = s.entity_id AND e.user_id = s.user_id CROSS JOIN query q
          WHERE ${sql.join(predicates, sql` AND `)} AND (s.document @@ q.terms OR (length(q.text) >= 3 AND s.title_normalized % q.text)${translitMatch})
          ORDER BY (ts_rank_cd(s.document,q.terms) + similarity(s.title_normalized,q.text) +
            0.1 / (1 + greatest(0,extract(epoch from (now() - s.updated_at))) / 86400) +
            CASE WHEN s.type = 'task' AND s.status IN ('todo','in_progress') THEN 0.05 ELSE 0 END) DESC,
            s.updated_at DESC, s.entity_id
          LIMIT ${query.limit + 1} OFFSET ${query.offset}`);
            const ids = result.rows.slice(0, query.limit).map((row) => row.entity_id);
            const records = new Map((await recordsFor(tx, userId, ids)).map((r) => [r.id, r]));
            groups.push({
              type,
              records: ids.flatMap((id) => (records.has(id) ? [records.get(id)!] : [])),
              hasMore: result.rows.length > query.limit,
            });
          }
          return { groups };
        },
        true,
      );
    },
  };
}
