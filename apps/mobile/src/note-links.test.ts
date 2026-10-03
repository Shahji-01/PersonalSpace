import { describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import { recordSchema, type RecordItem } from '@personalspace/validation';
import { plainTextDocument, type NoteDocument } from '@personalspace/editor-schema';
import { linkedFrom, referenceNotes } from './note-links';

function note(patch: Partial<RecordItem> = {}) {
  return recordSchema.parse({
    id: v7(),
    type: 'note',
    text: 'Original title\nContext',
    contentJson: plainTextDocument('Original title\nContext'),
    status: 'active',
    plannedDate: null,
    version: 1,
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    deletedAt: null,
    ...patch,
  });
}
describe('offline note connections', () => {
  it('resolves renamed and duplicate titles by ID, hides Trash and prevents linking pending notes', () => {
    const first = note(),
      second = note(),
      trashed = note({ deletedAt: '2026-10-02T01:00:00Z' });
    const records = [first, second, trashed];
    expect(referenceNotes(records, [second.id])).toMatchObject([
      { id: first.id, title: 'Original title', canLink: true },
      { id: second.id, title: 'Original title', canLink: false },
    ]);
    expect(referenceNotes([{ ...first, text: 'Renamed title' }], [])[0]).toMatchObject({
      id: first.id,
      title: 'Renamed title',
    });
  });
  it('derives backlinks from synced or optimistic content and removes them on unlink or Trash', () => {
    const target = note();
    const content: NoteDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'noteReference', attrs: { noteId: target.id } }] },
      ],
    };
    const source = note({ contentJson: content }),
      archived = note({ contentJson: content, archivedAt: '2026-10-02T00:00:00Z' });
    expect(
      linkedFrom([target, source, archived], target.id)
        .map((r) => r.id)
        .sort(),
    ).toEqual([source.id, archived.id].sort());
    expect(
      linkedFrom([target, { ...source, deletedAt: '2026-10-02T01:00:00Z' }], target.id),
    ).toEqual([]);
    expect(
      linkedFrom([target, { ...source, contentJson: plainTextDocument('No link') }], target.id),
    ).toEqual([]);
    const recovered = note({ recoveredFromId: target.id });
    expect(linkedFrom([target, recovered], target.id)).toEqual([recovered]);
    expect(referenceNotes([recovered], [])[0]?.context).toContain('Recovered draft');
  });
});
