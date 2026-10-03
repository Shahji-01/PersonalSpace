import { and, eq, inArray } from 'drizzle-orm';
import { v7 } from 'uuid';
import { entities, entityLinks, type Transaction } from '@personalspace/db';
import { noteReferenceIds, type NoteDocument } from '@personalspace/editor-schema';
import { DomainError } from './errors';

export async function validateNoteReferences(
  tx: Transaction,
  userId: string,
  content: NoteDocument,
) {
  const ids = noteReferenceIds(content);
  if (ids.length > 100)
    throw new DomainError('TOO_MANY_REFERENCES', 'Link to at most 100 different notes.', 422);
  const targets = ids.length
    ? await tx
        .select({ id: entities.id, purgedAt: entities.purgedAt })
        .from(entities)
        .where(
          and(eq(entities.userId, userId), eq(entities.type, 'note'), inArray(entities.id, ids)),
        )
    : [];
  if (targets.length !== ids.length)
    throw new DomainError(
      'NOTE_REFERENCE_NOT_FOUND',
      'A linked note is unavailable in this account. Remove the link and try again.',
      422,
    );
  return targets.filter((target) => !target.purgedAt);
}

export async function replaceNoteReferences(
  tx: Transaction,
  userId: string,
  sourceId: string,
  content: NoteDocument,
  version: number,
) {
  const live = await validateNoteReferences(tx, userId, content);
  await tx
    .delete(entityLinks)
    .where(
      and(
        eq(entityLinks.userId, userId),
        eq(entityLinks.sourceId, sourceId),
        eq(entityLinks.relation, 'references'),
      ),
    );
  // Keeping an owned deletion marker in the document makes old history and
  // offline drafts editable, without reviving links to permanently erased notes.
  if (live.length)
    await tx.insert(entityLinks).values(
      live.map((target) => ({
        id: v7(),
        userId,
        sourceId,
        targetId: target.id,
        relation: 'references',
        version,
      })),
    );
}
