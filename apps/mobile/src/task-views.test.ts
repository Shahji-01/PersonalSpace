import { describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import { recordSchema, type RecordItem } from '@personalspace/validation';
import { taskMatches, taskIsOverdue } from './task-views';

function task(patch: Partial<RecordItem> = {}) {
  const now = new Date('2026-10-01T12:00:00').toISOString();
  return recordSchema.parse({
    id: v7(),
    type: 'task',
    text: 'A task',
    status: 'todo',
    plannedDate: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...patch,
  });
}

describe('offline task views', () => {
  it('uses deadline instants for Overdue and the current local day for fixed deadlines', () => {
    const fixed = task({
      dueDate: '2026-10-02',
      dueTime: '00:30',
      timeMode: 'fixed',
      timezone: 'Asia/Kolkata',
      dueAt: '2026-10-01T19:00:00.000Z',
    });
    const before = new Date('2026-10-01T18:59:00Z');
    const after = new Date('2026-10-01T19:01:00Z');
    expect(taskMatches(fixed, 'today', '2026-10-01', before, 'America/Los_Angeles')).toBe(true);
    expect(taskIsOverdue(fixed, '2026-10-01', before, 'America/Los_Angeles')).toBe(false);
    expect(taskIsOverdue(fixed, '2026-10-01', after, 'America/Los_Angeles')).toBe(true);
    expect(
      taskIsOverdue({ ...fixed, status: 'done' }, '2026-10-01', after, 'America/Los_Angeles'),
    ).toBe(false);
    const floating = {
      ...fixed,
      timeMode: 'floating' as const,
      dueDate: '2026-10-01',
      dueTime: '13:00',
      dueAt: null,
    };
    expect(taskIsOverdue(floating, '2026-10-01', after, 'America/Los_Angeles')).toBe(false);
    expect(taskIsOverdue(floating, '2026-10-01', after, 'Asia/Kolkata')).toBe(true);
  });
  it('keeps archived tasks out of every active view without changing their status', () => {
    const record = task({
      archivedAt: new Date().toISOString(),
      dueDate: '2026-09-30',
      plannedDate: '2026-10-01',
    });
    for (const view of ['today', 'all', 'overdue', 'upcoming7', 'upcoming30', 'completed'] as const)
      expect(taskMatches(record, view, '2026-10-01')).toBe(false);
    expect(taskMatches(record, 'archived', '2026-10-01')).toBe(true);
    expect(
      taskMatches({ ...record, deletedAt: new Date().toISOString() }, 'archived', '2026-10-01'),
    ).toBe(false);
    expect(taskMatches({ ...record, archivedAt: null }, 'today', '2026-10-01')).toBe(true);
  });
  it('uses planned dates and deadlines independently and does not treat cancelled work as overdue', () => {
    expect(
      taskMatches(
        task({ plannedDate: '2026-10-01', dueDate: '2026-10-10' }),
        'today',
        '2026-10-01',
      ),
    ).toBe(true);
    expect(taskMatches(task({ dueDate: '2026-09-30' }), 'overdue', '2026-10-01')).toBe(true);
    expect(
      taskMatches(task({ dueDate: '2026-09-30', status: 'cancelled' }), 'today', '2026-10-01'),
    ).toBe(false);
    expect(
      taskMatches(task({ dueDate: '2026-09-30', status: 'done' }), 'overdue', '2026-10-01'),
    ).toBe(false);
  });
  it('keeps upcoming windows inclusive of today and handles month boundaries and leap days', () => {
    expect(taskMatches(task({ dueDate: '2026-10-07' }), 'upcoming7', '2026-10-01')).toBe(true);
    expect(taskMatches(task({ dueDate: '2026-10-08' }), 'upcoming7', '2026-10-01')).toBe(false);
    expect(taskMatches(task({ plannedDate: '2026-11-03' }), 'upcoming30', '2026-10-05')).toBe(true);
    expect(taskMatches(task({ dueDate: '2024-02-29' }), 'upcoming7', '2024-02-28')).toBe(true);
    expect(
      taskMatches(task({ dueDate: '2026-10-05', status: 'done' }), 'upcoming7', '2026-10-01'),
    ).toBe(false);
  });
  it('shows only recent completions and excludes subtasks and Trash from top-level views', () => {
    expect(
      taskMatches(
        task({ status: 'done', completedAt: new Date('2026-09-02T12:00:00').toISOString() }),
        'completed',
        '2026-10-01',
      ),
    ).toBe(true);
    expect(
      taskMatches(
        task({ status: 'done', completedAt: new Date('2026-09-01T12:00:00').toISOString() }),
        'completed',
        '2026-10-01',
      ),
    ).toBe(false);
    expect(taskMatches(task({ parentId: v7() }), 'all', '2026-10-01')).toBe(false);
    expect(taskMatches(task({ deletedAt: new Date().toISOString() }), 'all', '2026-10-01')).toBe(
      false,
    );
  });
});
