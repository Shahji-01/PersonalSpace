import { describe, expect, it } from 'vitest';
import { captureSchema, commandSchema, signupSchema } from './index';
const id = '01900000-0000-7000-8000-000000000001';
describe('boundary validation', () => {
  it('accepts an initial task deadline and prevents scheduling non-task captures', () => {
    expect(
      captureSchema.safeParse({
        id,
        type: 'task',
        text: 'Report',
        plannedDate: '2026-10-02',
        dueDate: '2026-10-05',
      }).success,
    ).toBe(true);
    expect(
      captureSchema.safeParse({ id, type: 'note', text: 'Report', dueDate: '2026-10-05' }).success,
    ).toBe(false);
    expect(
      captureSchema.safeParse({ id, type: 'task', text: 'Report', dueDate: '2026-02-30' }).success,
    ).toBe(false);
  });
  it('rejects ownership overrides and unknown commands', () => {
    expect(captureSchema.safeParse({ id, type: 'inbox', text: 'hi', userId: id }).success).toBe(
      false,
    );
    expect(commandSchema.safeParse({ op: 'transaction.void', id }).success).toBe(false);
  });
  it('validates actual calendar dates and task title limits', () => {
    expect(
      captureSchema.safeParse({ id, type: 'task', text: 'Read', plannedDate: '2026-02-30' })
        .success,
    ).toBe(false);
    expect(captureSchema.safeParse({ id, type: 'task', text: 'a'.repeat(501) }).success).toBe(
      false,
    );
    expect(captureSchema.safeParse({ id, type: 'note', text: 'a'.repeat(501) }).success).toBe(true);
  });
  it('accepts note lifecycle commands and rejects malformed ones', () => {
    expect(
      commandSchema.safeParse({ op: 'note.edit', id, text: 'Updated', baseVersion: 3 }).success,
    ).toBe(true);
    expect(commandSchema.safeParse({ op: 'note.delete', id, baseVersion: 3 }).success).toBe(true);
    expect(commandSchema.safeParse({ op: 'note.restore', id, baseVersion: 3 }).success).toBe(true);
    expect(commandSchema.safeParse({ op: 'note.purge', id, baseVersion: 3 }).success).toBe(true);
    expect(commandSchema.safeParse({ op: 'note.edit', id, text: '', baseVersion: 3 }).success).toBe(
      false,
    );
    expect(
      commandSchema.safeParse({ op: 'note.edit', id, text: 'x', baseVersion: -1 }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ op: 'note.delete', id, baseVersion: 3, extra: true }).success,
    ).toBe(false);
  });
  it('accepts task date and subtask commands and rejects malformed ones', () => {
    const parentId = '01900000-0000-7000-8000-000000000002';
    expect(
      commandSchema.safeParse({ op: 'task.reschedule', id, plannedDate: null, baseVersion: 2 })
        .success,
    ).toBe(true);
    expect(
      commandSchema.safeParse({
        op: 'task.reschedule',
        id,
        plannedDate: '2026-09-30',
        baseVersion: 2,
      }).success,
    ).toBe(true);
    expect(commandSchema.safeParse({ op: 'task.reschedule', id, baseVersion: 2 }).success).toBe(
      false,
    );
    expect(
      commandSchema.safeParse({
        op: 'task.reschedule',
        id,
        plannedDate: '2026-02-30',
        baseVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ op: 'task.addSubtask', id, parentId, text: 'Step one' }).success,
    ).toBe(true);
    expect(commandSchema.safeParse({ op: 'task.addSubtask', id, parentId, text: '' }).success).toBe(
      false,
    );
    expect(commandSchema.safeParse({ op: 'task.addSubtask', id, text: 'Orphan' }).success).toBe(
      false,
    );
  });
  it('accepts task rename and trash commands and rejects malformed ones', () => {
    expect(
      commandSchema.safeParse({ op: 'task.rename', id, text: 'Renamed', baseVersion: 4 }).success,
    ).toBe(true);
    expect(commandSchema.safeParse({ op: 'task.delete', id, baseVersion: 4 }).success).toBe(true);
    expect(commandSchema.safeParse({ op: 'task.restore', id, baseVersion: 4 }).success).toBe(true);
    expect(commandSchema.safeParse({ op: 'task.purge', id, baseVersion: 4 }).success).toBe(true);
    expect(
      commandSchema.safeParse({ op: 'task.rename', id, text: '', baseVersion: 4 }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ op: 'task.rename', id, text: 'a'.repeat(501), baseVersion: 4 })
        .success,
    ).toBe(false);
    expect(commandSchema.safeParse({ op: 'task.delete', id }).success).toBe(false);
  });
  it('normalizes tags and validates the setTags command', () => {
    const parsed = commandSchema.safeParse({
      op: 'item.setTags',
      id,
      tags: ['Work', 'work', ' Urgent '],
      baseVersion: 1,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.op === 'item.setTags')
      expect(parsed.data.tags).toEqual(['work', 'urgent']);
    expect(
      commandSchema.safeParse({ op: 'item.setTags', id, tags: [], baseVersion: 1 }).success,
    ).toBe(true);
    expect(
      commandSchema.safeParse({ op: 'item.setTags', id, tags: ['a'.repeat(31)], baseVersion: 1 })
        .success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({
        op: 'item.setTags',
        id,
        tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
        baseVersion: 1,
      }).success,
    ).toBe(false);
  });
  it('accepts task priority and due-date commands within bounds', () => {
    expect(
      commandSchema.safeParse({ op: 'task.setPriority', id, priority: 4, baseVersion: 1 }).success,
    ).toBe(true);
    expect(
      commandSchema.safeParse({ op: 'task.setPriority', id, priority: 0, baseVersion: 1 }).success,
    ).toBe(true);
    expect(
      commandSchema.safeParse({ op: 'task.setPriority', id, priority: 5, baseVersion: 1 }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ op: 'task.setPriority', id, priority: 1.5, baseVersion: 1 })
        .success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ op: 'task.setDueDate', id, dueDate: '2026-10-05', baseVersion: 1 })
        .success,
    ).toBe(true);
    expect(
      commandSchema.safeParse({ op: 'task.setDueDate', id, dueDate: null, baseVersion: 1 }).success,
    ).toBe(true);
    expect(
      commandSchema.safeParse({ op: 'task.setDueDate', id, dueDate: '2026-13-01', baseVersion: 1 })
        .success,
    ).toBe(false);
  });
  it('accepts task status transitions and rejects unknown statuses', () => {
    for (const status of ['todo', 'in_progress', 'done', 'cancelled'] as const)
      expect(
        commandSchema.safeParse({ op: 'task.setStatus', id, status, baseVersion: 1 }).success,
      ).toBe(true);
    expect(
      commandSchema.safeParse({ op: 'task.setStatus', id, status: 'archived', baseVersion: 1 })
        .success,
    ).toBe(false);
    expect(commandSchema.safeParse({ op: 'task.setStatus', id, baseVersion: 1 }).success).toBe(
      false,
    );
  });
  it('accepts note pin/favorite/archive commands and rejects malformed ones', () => {
    expect(
      commandSchema.safeParse({ op: 'note.setPinned', id, pinned: true, baseVersion: 1 }).success,
    ).toBe(true);
    expect(
      commandSchema.safeParse({ op: 'note.setFavorite', id, favorite: false, baseVersion: 1 })
        .success,
    ).toBe(true);
    expect(
      commandSchema.safeParse({ op: 'note.setArchived', id, archived: true, baseVersion: 1 })
        .success,
    ).toBe(true);
    expect(
      commandSchema.safeParse({ op: 'note.setPinned', id, pinned: 'yes', baseVersion: 1 }).success,
    ).toBe(false);
    expect(commandSchema.safeParse({ op: 'note.setArchived', id, baseVersion: 1 }).success).toBe(
      false,
    );
  });
  it('accepts inbox dismiss commands and rejects malformed ones', () => {
    expect(commandSchema.safeParse({ op: 'inbox.delete', id, baseVersion: 0 }).success).toBe(true);
    expect(commandSchema.safeParse({ op: 'inbox.restore', id, baseVersion: 0 }).success).toBe(true);
    expect(commandSchema.safeParse({ op: 'inbox.purge', id, baseVersion: 0 }).success).toBe(true);
    expect(commandSchema.safeParse({ op: 'inbox.delete', id }).success).toBe(false);
    expect(commandSchema.safeParse({ op: 'inbox.delete', baseVersion: 0 }).success).toBe(false);
  });
  it('requires explicit age and preview consent', () => {
    expect(
      signupSchema.safeParse({ name: 'A', email: 'a@example.test', password: 'long-test-password' })
        .success,
    ).toBe(false);
  });
});
