import { and, eq, inArray, isNull } from 'drizzle-orm';
import { v7 } from 'uuid';
import { z } from 'zod';
import { entities, tasks, recurrenceRules, type Transaction } from '@personalspace/db';
import {
  recurrenceSetupSchema,
  recurrenceRRule,
  firstOccurrence,
  nextOccurrence,
  shiftCalendarDate,
  calendarDayOffset,
  recurringInstant,
  type RecurrenceSetup,
} from '@personalspace/validation';
import { DomainError } from './errors';

type Task = typeof tasks.$inferSelect;
const templateSchema = z.object({
  title: z.string(),
  priority: z.number(),
  projectId: z.string().nullable(),
  parentId: z.string().nullable(),
  descriptionJson: z.unknown().nullable(),
  descriptionText: z.string(),
  descriptionSchemaVersion: z.number(),
  estimatedMinutes: z.number().nullable(),
  dueOffset: z.number().int().nullable(),
  dueTime: z.string().nullable(),
  timeMode: z.enum(['floating', 'fixed']),
  timezone: z.string().nullable(),
  tags: z.array(z.string()),
});
async function templateFor(tx: Transaction, userId: string, task: Task, anchor: string) {
  const [entity] = await tx
    .select({ tags: entities.tags })
    .from(entities)
    .where(and(eq(entities.id, task.id), eq(entities.userId, userId)));
  return templateSchema.parse({
    ...task,
    dueTime: task.dueTime?.slice(0, 5) ?? null,
    dueOffset: task.dueDate ? calendarDayOffset(anchor, task.dueDate) : null,
    tags: entity?.tags ?? [],
  });
}
function deadlines(template: z.infer<typeof templateSchema>, scheduled: string) {
  const dueDate =
    template.dueOffset === null ? null : shiftCalendarDate(scheduled, template.dueOffset);
  const instant = dueDate
    ? recurringInstant(dueDate, template.dueTime, template.timeMode, template.timezone ?? 'UTC')
    : null;
  return {
    dueDate,
    dueTime: template.dueTime,
    timeMode: template.timeMode,
    timezone: template.timezone,
    dueAt: instant ? new Date(instant) : null,
  };
}
async function ruleFor(tx: Transaction, userId: string, id: string) {
  const [rule] = await tx
    .select()
    .from(recurrenceRules)
    .where(and(eq(recurrenceRules.id, id), eq(recurrenceRules.userId, userId)));
  if (!rule)
    throw new DomainError('RECURRENCE_NOT_FOUND', 'This repeating schedule was not found.', 404);
  return rule;
}
export async function setRecurrence(
  tx: Transaction,
  userId: string,
  task: Task,
  settings: RecurrenceSetup | null,
  version: number,
  keepCurrentDate = false,
) {
  if (task.recurrenceAdvanced || task.status === 'done' || task.status === 'cancelled')
    throw new DomainError(
      'RECURRENCE_ALREADY_ADVANCED',
      'Edit the next open occurrence to change future tasks.',
      422,
    );
  if (task.parentId && settings) {
    const [parent] = await tx
      .select({ ruleId: tasks.recurrenceRuleId })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.id, task.parentId)));
    if (parent?.ruleId)
      throw new DomainError(
        'NESTED_RECURRENCE',
        'This subtask repeats with its parent. Change the parent schedule instead.',
        422,
      );
  }
  if (task.recurrenceRuleId)
    await tx
      .update(recurrenceRules)
      .set({ endedAt: new Date(), version, updatedAt: new Date() })
      .where(
        and(eq(recurrenceRules.id, task.recurrenceRuleId), eq(recurrenceRules.userId, userId)),
      );
  if (!settings) {
    await tx
      .update(tasks)
      .set({
        recurrenceRuleId: null,
        recurrenceSeriesId: null,
        occurrenceDate: null,
        occurrenceNumber: null,
        version,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
    if (task.recurrenceRuleId) await purgeUnusedRecurrence(tx, userId, [task.recurrenceRuleId]);
    return;
  }
  const first = keepCurrentDate ? settings.anchorDate : firstOccurrence(settings);
  if (!first)
    throw new DomainError('EMPTY_RECURRENCE', 'No occurrence fits before the end date.', 422);
  const children = await tx
    .select({ id: tasks.id, ruleId: tasks.recurrenceRuleId })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.parentId, task.id), isNull(tasks.deletedAt)))
    .limit(101);
  if (children.length > 100)
    throw new DomainError(
      'RECURRENCE_SUBTASK_LIMIT',
      'Repeating tasks support up to 100 subtasks.',
      422,
    );
  if (children.some((child) => child.ruleId))
    throw new DomainError(
      'NESTED_RECURRENCE',
      'Stop the subtask schedules before repeating the parent task.',
      422,
    );
  const anchor = task.plannedDate ?? settings.anchorDate;
  const template = await templateFor(tx, userId, task, anchor);
  const id = v7();
  await tx
    .insert(recurrenceRules)
    .values({ id, userId, version, settings, rrule: recurrenceRRule(settings), template });
  await tx
    .update(tasks)
    .set({
      recurrenceRuleId: id,
      recurrenceSeriesId: task.recurrenceSeriesId ?? v7(),
      occurrenceDate: first,
      occurrenceNumber: 1,
      plannedDate: first,
      ...deadlines(template, first),
      ...(first === anchor ? { dueAt: task.dueAt } : {}),
      version,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
  if (task.recurrenceRuleId) await purgeUnusedRecurrence(tx, userId, [task.recurrenceRuleId]);
}
export async function updateFutureRecurrence(
  tx: Transaction,
  userId: string,
  task: Task,
  version: number,
) {
  if (!task.recurrenceRuleId) return;
  if (!task.plannedDate)
    throw new DomainError(
      'RECURRENCE_DATE_REQUIRED',
      'Keep a planned date for future occurrences, or stop repeating first.',
      422,
    );
  const rule = await ruleFor(tx, userId, task.recurrenceRuleId);
  const settings = recurrenceSetupSchema.parse(rule.settings);
  await setRecurrence(
    tx,
    userId,
    task,
    {
      ...settings,
      anchorDate: task.plannedDate ?? task.occurrenceDate!,
      anchorTime: task.dueTime?.slice(0, 5) ?? null,
      timeMode: task.dueTime ? (task.timeMode as 'floating' | 'fixed') : settings.timeMode,
      timezone: task.dueTime ? (task.timezone ?? settings.timezone) : settings.timezone,
      count: settings.count ? Math.max(1, settings.count - (task.occurrenceNumber! - 1)) : null,
    },
    version,
    true,
  );
}
export async function advanceRecurrence(
  tx: Transaction,
  userId: string,
  task: Task,
  version: number,
  completedAt: Date,
  currentTimezone?: string,
): Promise<string[]> {
  if (!task.recurrenceRuleId || task.recurrenceAdvanced) return [];
  const rule = await ruleFor(tx, userId, task.recurrenceRuleId);
  const settings = recurrenceSetupSchema.parse(rule.settings);
  const next = rule.endedAt
    ? null
    : nextOccurrence(
        settings,
        task.occurrenceDate!,
        task.occurrenceNumber!,
        completedAt.toISOString(),
        currentTimezone ?? settings.timezone,
      );
  let nextId: string | null = null;
  const ids: string[] = [];
  if (next) {
    const template = templateSchema.parse(rule.template);
    const { dueOffset: _offset, tags, ...base } = template;
    nextId = v7();
    await tx.insert(entities).values({ id: nextId, userId, type: 'task', version, tags });
    await tx.insert(tasks).values({
      ...base,
      ...deadlines(template, next),
      id: nextId,
      userId,
      version,
      plannedDate: next,
      status: 'todo',
      recurrenceRuleId: rule.id,
      recurrenceSeriesId: task.recurrenceSeriesId,
      occurrenceDate: next,
      occurrenceNumber: task.occurrenceNumber! + 1,
    });
    ids.push(nextId);
    const children = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.parentId, task.id), isNull(tasks.deletedAt)))
      .limit(101);
    if (children.length > 100)
      throw new DomainError(
        'RECURRENCE_SUBTASK_LIMIT',
        'Repeating tasks support up to 100 subtasks.',
        422,
      );
    for (const child of children) {
      const childTemplate = await templateFor(tx, userId, child, task.occurrenceDate!);
      const { dueOffset: _childOffset, tags: childTags, ...childBase } = childTemplate;
      const childId = v7();
      await tx
        .insert(entities)
        .values({ id: childId, userId, type: 'task', version, tags: childTags });
      await tx.insert(tasks).values({
        ...childBase,
        ...deadlines(childTemplate, next),
        id: childId,
        userId,
        version,
        parentId: nextId,
        projectId: template.projectId,
        plannedDate: child.plannedDate
          ? shiftCalendarDate(next, calendarDayOffset(task.occurrenceDate!, child.plannedDate))
          : null,
        status: 'todo',
      });
      ids.push(childId);
    }
  }
  await tx
    .update(tasks)
    .set({ nextTaskId: nextId, recurrenceAdvanced: true })
    .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
  return ids;
}
export async function purgeUnusedRecurrence(tx: Transaction, userId: string, ruleIds: string[]) {
  for (const id of new Set(ruleIds)) {
    const remaining = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.recurrenceRuleId, id)))
      .limit(1);
    if (!remaining.length)
      await tx
        .delete(recurrenceRules)
        .where(and(eq(recurrenceRules.userId, userId), inArray(recurrenceRules.id, [id])));
  }
}
