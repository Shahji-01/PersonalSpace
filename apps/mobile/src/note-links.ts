import { noteReferenceIds } from '@personalspace/editor-schema';
import type { RecordItem } from '@personalspace/validation';

export type ReferenceNote = { id: string; title: string; context: string; canLink: boolean };
export function referenceNotes(records: RecordItem[], pendingIds: string[]): ReferenceNote[] {
  return records
    .filter((record) => record.type === 'note' && !record.deletedAt)
    .map((record) => ({
      id: record.id,
      title: record.text.split('\n')[0]?.trim() || 'Untitled note',
      context: `${record.recoveredFromId ? 'Recovered draft · ' : ''}${record.archivedAt ? 'Archived · ' : ''}${record.text.split('\n').slice(1).join(' ').slice(0, 80) || record.createdAt.slice(0, 10)}`,
      canLink: record.version > 0 && !pendingIds.includes(record.id),
    }));
}
export function linkedFrom(records: RecordItem[], noteId: string): RecordItem[] {
  return records
    .filter(
      (record) =>
        record.type === 'note' &&
        !record.deletedAt &&
        (record.recoveredFromId === noteId ||
          (record.contentJson && noteReferenceIds(record.contentJson).includes(noteId))),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
