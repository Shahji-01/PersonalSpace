import {
  searchQuerySchema,
  searchableTypes,
  searchTokens,
  recordSchema,
  type SearchQuery,
  type SearchResponse,
} from '@personalspace/validation';
import type { SQLiteDatabase } from 'expo-sqlite';

// Triggers keep the index in the same SQLite transaction as optimistic writes,
// rollbacks, remote merges and permanent deletions.
export const searchIndexSql = `
CREATE VIRTUAL TABLE IF NOT EXISTS record_search USING fts5(
  user_id UNINDEXED, entity_id UNINDEXED, title, body, tags,
  tokenize = "unicode61 remove_diacritics 2 categories 'L* N* M* Co'"
);
CREATE TABLE IF NOT EXISTS search_index_meta (version INTEGER PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS records_search_insert AFTER INSERT ON records BEGIN
  DELETE FROM record_search WHERE user_id = new.user_id AND entity_id = new.id;
  INSERT INTO record_search(user_id,entity_id,title,body,tags)
  SELECT new.user_id,new.id,
    CASE WHEN instr(json_extract(new.data,'$.text'),char(10)) > 0
      THEN substr(json_extract(new.data,'$.text'),1,instr(json_extract(new.data,'$.text'),char(10))-1)
      ELSE json_extract(new.data,'$.text') END,
    json_extract(new.data,'$.text') || ' ' || coalesce((SELECT group_concat(value,' ') FROM json_tree(new.data,'$.descriptionJson') WHERE key = 'text'),''),
    coalesce((SELECT group_concat(value,' ') FROM json_each(new.data,'$.tags')),'')
  WHERE json_extract(new.data,'$.deletedAt') IS NULL
    AND json_extract(new.data,'$.type') IN ('note','task','project','inbox')
    AND NOT (json_extract(new.data,'$.type') = 'inbox' AND json_extract(new.data,'$.status') <> 'new');
END;
CREATE TRIGGER IF NOT EXISTS records_search_delete AFTER DELETE ON records BEGIN
  DELETE FROM record_search WHERE user_id = old.user_id AND entity_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS records_search_update AFTER UPDATE ON records BEGIN
  DELETE FROM record_search WHERE user_id = old.user_id AND entity_id = old.id;
  INSERT INTO record_search(user_id,entity_id,title,body,tags)
  SELECT new.user_id,new.id,json_extract(new.data,'$.text'),
    json_extract(new.data,'$.text') || ' ' || coalesce((SELECT group_concat(value,' ') FROM json_tree(new.data,'$.descriptionJson') WHERE key = 'text'),''),
    coalesce((SELECT group_concat(value,' ') FROM json_each(new.data,'$.tags')),'')
  WHERE json_extract(new.data,'$.deletedAt') IS NULL
    AND json_extract(new.data,'$.type') IN ('note','task','project','inbox')
    AND NOT (json_extract(new.data,'$.type') = 'inbox' AND json_extract(new.data,'$.status') <> 'new');
END;`;

export async function searchLocal(
  db: SQLiteDatabase,
  userId: string,
  raw: SearchQuery,
): Promise<SearchResponse> {
  const query = searchQuerySchema.parse(raw);
  const tokens = searchTokens(query.q);
  if (!tokens.length) return { groups: [] };
  const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
  const groups: SearchResponse['groups'] = [];
  for (const type of query.type ? [query.type] : searchableTypes) {
    const conditions = [
      'record_search MATCH ?',
      'record_search.user_id = ?',
      'r.user_id = ?',
      "json_extract(r.data,'$.type') = ?",
    ];
    const args: (string | number)[] = [match, userId, userId, type];
    if (!query.includeArchived)
      conditions.push(
        "json_extract(r.data,'$.archivedAt') IS NULL AND json_extract(r.data,'$.status') <> 'archived'",
      );
    if (query.tag) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(r.data,'$.tags') WHERE value = ?)");
      args.push(query.tag.toLowerCase());
    }
    for (const key of ['projectId', 'folderId', 'status'] as const)
      if (query[key]) {
        conditions.push(`json_extract(r.data,'$.${key}') = ?`);
        args.push(query[key]);
      }
    if (query.from) {
      conditions.push("substr(json_extract(r.data,'$.createdAt'),1,10) >= ?");
      args.push(query.from);
    }
    if (query.to) {
      conditions.push("substr(json_extract(r.data,'$.createdAt'),1,10) <= ?");
      args.push(query.to);
    }
    const rows = await db.getAllAsync<{ data: string }>(
      `SELECT r.data FROM record_search JOIN records r ON r.id = record_search.entity_id AND r.user_id = record_search.user_id WHERE ${conditions.join(' AND ')} ORDER BY bm25(record_search,0,0,10,5,2), json_extract(r.data,'$.updatedAt') DESC, r.id LIMIT ? OFFSET ?`,
      ...args,
      query.limit + 1,
      query.offset,
    );
    groups.push({
      type,
      records: rows.slice(0, query.limit).map((row) => recordSchema.parse(JSON.parse(row.data))),
      hasMore: rows.length > query.limit,
    });
  }
  return { groups };
}
