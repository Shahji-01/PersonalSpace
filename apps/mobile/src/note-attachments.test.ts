import { describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import { commandSchema, recordSchema } from '@personalspace/validation';
import { noteAttachments } from './note-attachments';

function fixture() {
  const parent = recordSchema.parse({
    id: v7(),
    type: 'note',
    text: 'Note',
    status: 'active',
    plannedDate: null,
    deletedAt: null,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const id = v7();
  const file = recordSchema.parse({
    ...parent,
    id,
    type: 'attachment',
    parentId: parent.id,
    attachment: {
      id,
      parentId: parent.id,
      filename: 'नोट.pdf',
      size: 1024,
      mime: 'application/pdf',
      sha256: 'a'.repeat(64),
      status: 'ready',
    },
  });
  return { parent, file };
}
describe('editor attachment choices', () => {
  it('offers ready image previews without counting a cached thumbnail as the full offline file', () => {
    const { parent, file } = fixture();
    file.attachment = { ...file.attachment!, hasThumbnail: true, processedMime: 'image/webp' };
    const result = noteAttachments([parent, file], parent.id, [
      {
        id: file.id,
        uri: 'file:///thumbnail',
        mime: 'image/webp',
        size: 100,
        sha256: 'a'.repeat(64),
        pinned: true,
        accessedAt: 1,
        variant: 'thumbnail',
      },
    ]);
    expect(result[0]!.canPreview).toBe(true);
    expect(result[0]!.detail).toContain('Preview offline');
    expect(result[0]!.detail).not.toContain('Kept offline');
    file.attachment.status = 'processing';
    expect(noteAttachments([parent, file], parent.id)[0]!.canPreview).toBe(false);
  });
  it('offers this note’s registered files and resolves cross-note references without offering them for insertion', () => {
    const { parent, file } = fixture();
    expect(noteAttachments([parent, file], parent.id)).toMatchObject([
      { filename: 'नोट.pdf', canInsert: true, canOpen: true },
    ]);
    expect(noteAttachments([parent, file], v7())).toMatchObject([
      { canInsert: false, canOpen: true },
    ]);
    expect(noteAttachments([parent, { ...file, version: 0 }], parent.id)[0]!.canInsert).toBe(false);
  });
  it('hides deleted parents/files and durable local removals, while reflecting processing and offline status', () => {
    const { parent, file } = fixture();
    expect(
      noteAttachments([{ ...parent, deletedAt: new Date().toISOString() }, file], parent.id),
    ).toEqual([]);
    expect(
      noteAttachments([parent, { ...file, deletedAt: new Date().toISOString() }], parent.id),
    ).toEqual([]);
    expect(noteAttachments([parent, file], parent.id, [], [file.id])).toEqual([]);
    expect(
      noteAttachments(
        [parent, { ...file, attachment: { ...file.attachment!, status: 'processing' } }],
        parent.id,
      ),
    ).toMatchObject([{ canInsert: true, canOpen: false, detail: '0.00 MB · Processing' }]);
    expect(
      noteAttachments([parent, file], parent.id, [
        {
          id: file.id,
          uri: 'file:///cache/x',
          mime: 'application/pdf',
          size: 1024,
          sha256: 'a'.repeat(64),
          pinned: true,
          accessedAt: 1,
        },
      ])[0]!.detail,
    ).toContain('Kept offline');
  });
  it('rejects attachment references in task descriptions', () => {
    expect(
      commandSchema.safeParse({
        op: 'task.updateDescription',
        id: v7(),
        baseVersion: 1,
        contentSchemaVersion: 1,
        contentJson: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'attachmentReference', attrs: { attachmentId: v7() } }],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
