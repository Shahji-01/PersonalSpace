import type { RecordItem } from '@personalspace/validation';
import type { AttachmentCacheEntry } from './attachment-cache-store';

export type NoteAttachment = {
  id: string;
  filename: string;
  detail: string;
  canInsert: boolean;
  canOpen: boolean;
  canPreview?: boolean;
};
export function noteAttachments(
  records: RecordItem[],
  noteId: string,
  cached: AttachmentCacheEntry[] = [],
  removed: string[] = [],
): NoteAttachment[] {
  const parents = new Set(
    records.filter((row) => row.type === 'note' && !row.deletedAt).map((row) => row.id),
  );
  return records
    .filter(
      (row) =>
        row.type === 'attachment' &&
        row.attachment &&
        !row.deletedAt &&
        row.parentId &&
        parents.has(row.parentId) &&
        !removed.includes(row.id),
    )
    .map((row) => {
      const file = row.attachment!,
        local = cached.find((entry) => entry.id === row.id && entry.variant !== 'thumbnail');
      const previewOffline = cached.some(
        (entry) => entry.id === row.id && entry.variant === 'thumbnail',
      );
      const status =
        file.status === 'ready'
          ? local?.pinned
            ? 'Kept offline'
            : local
              ? 'Downloaded'
              : 'Ready to download'
          : file.status === 'processing'
            ? 'Processing'
            : file.status === 'rejected'
              ? 'File not accepted'
              : 'Uploading';
      return {
        id: row.id,
        filename: file.filename,
        detail: `${(file.size / (1024 * 1024)).toFixed(2)} MB · ${status}${file.status === 'ready' && previewOffline && !local ? ' · Preview offline' : ''}`,
        canInsert: row.parentId === noteId && row.version > 0 && file.status !== 'rejected',
        canOpen: file.status === 'ready',
        canPreview:
          file.status === 'ready' && file.hasThumbnail && file.processedMime === 'image/webp',
      };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id));
}
