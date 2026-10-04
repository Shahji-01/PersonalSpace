import { and, eq, inArray } from 'drizzle-orm';
import { entities, type Transaction } from '@personalspace/db';
import { attachmentReferenceIds, type NoteDocument } from '@personalspace/editor-schema';
import { DomainError } from './errors';

export async function validateAttachmentReferences(
  tx: Transaction,
  userId: string,
  content: NoteDocument,
) {
  const ids = attachmentReferenceIds(content);
  if (ids.length > 100)
    throw new DomainError('TOO_MANY_ATTACHMENTS', 'Link to at most 100 different files.', 422);
  if (!ids.length) return;
  const owned = await tx
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(eq(entities.userId, userId), eq(entities.type, 'attachment'), inArray(entities.id, ids)),
    );
  if (owned.length !== ids.length)
    throw new DomainError(
      'ATTACHMENT_REFERENCE_NOT_FOUND',
      'A linked file is unavailable in this account. Remove its label and try again.',
      422,
    );
  // Owned deletion markers remain valid in drafts/history. The node cannot restore
  // bytes or authorize a download; the attachment's live parent and status do that.
  // References can survive copying a draft into another owned note.
}
