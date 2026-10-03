import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { v7 } from 'uuid';
import { notes, noteVersions, withUser, type Database, type Transaction } from '@personalspace/db';
import { noteHistoryResponseSchema, type NoteVersion } from '@personalspace/validation';
import { DomainError } from './errors';
import { documentText, readDocument, type NoteDocument } from '@personalspace/editor-schema';

export async function snapshotNote(
  tx: Transaction,
  userId: string,
  noteId: string,
  reason: NoteVersion['reason'],
) {
  const [note] = await tx
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)));
  if (!note) return;
  await tx
    .insert(noteVersions)
    .values({
      id: v7(),
      userId,
      noteId,
      version: note.version,
      title: note.title,
      contentJson: note.contentJson,
      contentSchemaVersion: note.contentSchemaVersion,
      reason,
    })
    .onConflictDoNothing();
  await retainNoteHistory(tx, userId, noteId);
}

export async function checkpointNote(
  tx: Transaction,
  userId: string,
  noteId: string,
  version: number,
  content: NoteDocument,
  reason: 'interval' | 'session_end',
) {
  const [latest] = await tx
    .select({ content: noteVersions.contentJson })
    .from(noteVersions)
    .where(and(eq(noteVersions.userId, userId), eq(noteVersions.noteId, noteId)))
    .orderBy(desc(noteVersions.version))
    .limit(1);
  if (latest && JSON.stringify(readDocument(latest.content)) === JSON.stringify(content)) return;
  await tx.insert(noteVersions).values({
    id: v7(),
    userId,
    noteId,
    version,
    title: documentText(content).split('\n')[0]!.slice(0, 120) || 'Untitled note',
    contentJson: content,
    contentSchemaVersion: 1,
    reason,
  });
  await retainNoteHistory(tx, userId, noteId);
}

async function retainNoteHistory(tx: Transaction, userId: string, noteId: string) {
  // Keep the union of the latest 50 snapshots and every snapshot from the last 30 days.
  await tx.execute(sql`
    DELETE FROM note_versions WHERE user_id = ${userId} AND note_id = ${noteId} AND id IN (
      SELECT id FROM (
        SELECT id,created_at,row_number() OVER (ORDER BY version DESC) AS position
        FROM note_versions WHERE user_id = ${userId} AND note_id = ${noteId}
      ) ranked WHERE position > 50 AND created_at < now() - interval '30 days'
    )
  `);
}

export function createNoteHistoryService(db: Database) {
  return {
    list: (userId: string, noteId: string, beforeVersion?: number) =>
      withUser(
        db,
        userId,
        async (tx) => {
          const [note] = await tx
            .select({ id: notes.id })
            .from(notes)
            .where(and(eq(notes.id, noteId), eq(notes.userId, userId)));
          if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not found.', 404);
          const rows = await tx
            .select()
            .from(noteVersions)
            .where(
              and(
                eq(noteVersions.userId, userId),
                eq(noteVersions.noteId, noteId),
                beforeVersion === undefined ? undefined : lt(noteVersions.version, beforeVersion),
              ),
            )
            .orderBy(desc(noteVersions.version))
            .limit(21);
          const page = rows.slice(0, 20);
          return noteHistoryResponseSchema.parse({
            versions: page.map(({ userId: _userId, ...row }) => ({
              ...row,
              createdAt: row.createdAt.toISOString(),
            })),
            nextCursor: rows.length > 20 ? page.at(-1)!.version : null,
          });
        },
        true,
      ),
  };
}
