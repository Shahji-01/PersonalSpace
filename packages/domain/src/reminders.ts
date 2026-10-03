import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { reminders, type Transaction } from '@personalspace/db';
import { computeFireAt, computeSnoozeUntil, type SnoozeDuration } from '@personalspace/validation';
import { DomainError } from './errors';

export async function reminderFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(reminders)
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId), isNull(reminders.deletedAt)))
  )[0];
}

export async function trashedReminderFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(reminders)
      .where(
        and(eq(reminders.id, id), eq(reminders.userId, userId), isNotNull(reminders.deletedAt)),
      )
  )[0];
}

export async function createReminder(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  input: {
    entityId: string | null;
    title: string;
    remindDate: string;
    remindTime: string;
    timeMode: 'floating' | 'fixed';
    timezone: string;
  },
): Promise<string[]> {
  const fireAt = computeFireAt(input.remindDate, input.remindTime, input.timezone);
  await tx.insert(reminders).values({
    id,
    userId,
    version,
    entityId: input.entityId,
    title: input.title,
    remindDate: input.remindDate,
    remindTime: input.remindTime,
    timeMode: input.timeMode,
    timezone: input.timezone,
    fireAt,
    status: 'scheduled',
  });
  return [id];
}

export async function updateReminder(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  input: {
    title?: string;
    remindDate?: string;
    remindTime?: string;
    timeMode?: 'floating' | 'fixed';
    timezone?: string;
  },
): Promise<string[]> {
  const reminder = await reminderFor(tx, userId, id);
  if (!reminder) throw new DomainError('REMINDER_NOT_FOUND', 'This reminder was not found.', 404);
  if (reminder.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This reminder changed on another device. Refresh and try again.',
    );
  // Only active reminders can be updated.
  if (
    reminder.status === 'dismissed' ||
    reminder.status === 'done' ||
    reminder.status === 'cancelled'
  )
    throw new DomainError(
      'REMINDER_CLOSED',
      'This reminder has already been completed or dismissed.',
      422,
    );
  const date = input.remindDate ?? reminder.remindDate;
  const time = input.remindTime ?? reminder.remindTime!.slice(0, 5);
  const tz = input.timezone ?? reminder.timezone;
  const fireAt = computeFireAt(date, time, tz);

  await tx
    .update(reminders)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.remindDate !== undefined ? { remindDate: input.remindDate } : {}),
      ...(input.remindTime !== undefined ? { remindTime: input.remindTime } : {}),
      ...(input.timeMode !== undefined ? { timeMode: input.timeMode } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      fireAt,
      // Rescheduling resets snooze and re-activates a snoozed or fired reminder.
      status: 'scheduled',
      snoozedUntil: null,
      version,
      updatedAt: new Date(),
    })
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)));
  return [id];
}

export async function snoozeReminder(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  duration: SnoozeDuration,
  currentTimezone: string,
): Promise<string[]> {
  const reminder = await reminderFor(tx, userId, id);
  if (!reminder) throw new DomainError('REMINDER_NOT_FOUND', 'This reminder was not found.', 404);
  if (reminder.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This reminder changed on another device. Refresh and try again.',
    );
  if (
    reminder.status !== 'scheduled' &&
    reminder.status !== 'fired' &&
    reminder.status !== 'snoozed'
  )
    throw new DomainError('REMINDER_CLOSED', 'This reminder cannot be snoozed.', 422);

  const snoozedUntil = computeSnoozeUntil(duration, currentTimezone);
  await tx
    .update(reminders)
    .set({
      status: 'snoozed',
      snoozedUntil,
      fireAt: snoozedUntil,
      version,
      updatedAt: new Date(),
    })
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)));
  return [id];
}

export async function setReminderStatus(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  status: 'dismissed' | 'done' | 'cancelled',
): Promise<string[]> {
  const reminder = await reminderFor(tx, userId, id);
  if (!reminder) throw new DomainError('REMINDER_NOT_FOUND', 'This reminder was not found.', 404);
  if (reminder.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This reminder changed on another device. Refresh and try again.',
    );
  if (
    reminder.status === 'dismissed' ||
    reminder.status === 'done' ||
    reminder.status === 'cancelled'
  )
    throw new DomainError('REMINDER_CLOSED', 'This reminder has already been completed.', 422);

  await tx
    .update(reminders)
    .set({
      status,
      snoozedUntil: null,
      version,
      updatedAt: new Date(),
    })
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)));
  return [id];
}
