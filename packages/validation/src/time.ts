import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

export function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
export const timeZoneSchema = z
  .string()
  .max(100)
  .refine(isTimeZone, 'Choose a valid IANA timezone, such as Asia/Kolkata.');
export const wallTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time (HH:mm).');
export const deadlineSchema = z
  .strictObject({
    dueDate: z.iso.date().nullable(),
    dueTime: wallTimeSchema.nullable(),
    timeMode: z.enum(['floating', 'fixed']),
    timezone: timeZoneSchema.nullable(),
    occurrence: z.enum(['earlier', 'later']).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.dueTime && !value.dueDate)
      ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'A deadline time needs a date.' });
    if (value.dueTime && !value.timezone)
      ctx.addIssue({
        code: 'custom',
        path: ['timezone'],
        message: 'Choose a timezone for a timed deadline.',
      });
    if (
      !value.dueTime &&
      (value.timeMode === 'fixed' || value.timezone !== null || value.occurrence !== null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'A date-only deadline has no timezone or clock occurrence.',
      });
    if (value.timeMode === 'floating' && value.occurrence !== null)
      ctx.addIssue({ code: 'custom', message: 'Clock occurrences apply only to fixed deadlines.' });
  });
export type Deadline = z.infer<typeof deadlineSchema>;
export function currentTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export class DeadlineTimeError extends Error {
  constructor(
    public readonly code: 'NONEXISTENT_TIME' | 'AMBIGUOUS_TIME',
    message: string,
  ) {
    super(message);
  }
}

export function fixedDeadlineInstant(input: Deadline): string | null {
  if (!input.dueDate || !input.dueTime || input.timeMode !== 'fixed') return null;
  const wall = Temporal.PlainDateTime.from(`${input.dueDate}T${input.dueTime}`);
  const earlier = wall.toZonedDateTime(input.timezone!, { disambiguation: 'earlier' });
  const later = wall.toZonedDateTime(input.timezone!, { disambiguation: 'later' });
  if (!earlier.toPlainDateTime().equals(wall) || !later.toPlainDateTime().equals(wall))
    throw new DeadlineTimeError(
      'NONEXISTENT_TIME',
      'That local time does not exist because the clocks move forward. Choose another time.',
    );
  if (earlier.epochMilliseconds !== later.epochMilliseconds && input.occurrence === null)
    throw new DeadlineTimeError(
      'AMBIGUOUS_TIME',
      'The clocks repeat this time. Choose the first or second occurrence.',
    );
  return (input.occurrence === 'later' ? later : earlier)
    .toInstant()
    .toString({ smallestUnit: 'millisecond' });
}

export type DeadlineRecord = Pick<Deadline, 'dueDate' | 'dueTime' | 'timeMode' | 'timezone'> & {
  dueAt: string | null;
};
export function deadlineInstant(record: DeadlineRecord, zone = currentTimeZone()): string | null {
  if (!record.dueDate || !record.dueTime) return null;
  if (record.timeMode === 'fixed') return record.dueAt;
  // Floating deadlines follow the current zone. Compatible resolution chooses the
  // first repeated clock time and moves a skipped clock time forward by its gap.
  return Temporal.PlainDateTime.from(`${record.dueDate}T${record.dueTime}`)
    .toZonedDateTime(zone, { disambiguation: 'compatible' })
    .toInstant()
    .toString({ smallestUnit: 'millisecond' });
}
export function deadlineLocalDate(record: DeadlineRecord, zone = currentTimeZone()): string | null {
  return record.timeMode === 'fixed' && record.dueAt
    ? Temporal.Instant.from(record.dueAt).toZonedDateTimeISO(zone).toPlainDate().toString()
    : record.dueDate;
}
export function deadlineLabel(record: DeadlineRecord, zone = currentTimeZone()): string {
  if (!record.dueDate) return 'No deadline';
  if (!record.dueTime) return record.dueDate;
  if (record.timeMode === 'fixed' && record.dueAt) {
    const local = Temporal.Instant.from(record.dueAt).toZonedDateTimeISO(zone);
    return `${local.toPlainDate()} ${local.toPlainTime().toString({ smallestUnit: 'minute' })} ${zone} (fixed)`;
  }
  return `${record.dueDate} ${record.dueTime} (local time)`;
}

// --- Reminder time ---

export const reminderTimeSchema = z.strictObject({
  remindDate: z.iso.date(),
  remindTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time (HH:mm).'),
  timeMode: z.enum(['floating', 'fixed']),
  timezone: z
    .string()
    .max(100)
    .refine(isTimeZone, 'Choose a valid IANA timezone, such as Asia/Kolkata.'),
});
export type ReminderTime = z.infer<typeof reminderTimeSchema>;

/**
 * Compute the absolute instant at which a reminder should fire.
 * - **Fixed**: the instant is determined by the date/time in the given timezone.
 * - **Floating**: the instant is determined by the date/time in the given timezone, but
 *   should be recomputed whenever the user's timezone changes.
 *
 * Both modes use compatible disambiguation (moves skipped times forward, picks the first
 * repeated time) because reminders should never be silently lost.
 */
export function computeFireAt(
  remindDate: string,
  remindTime: string,
  timezone: string,
): Date {
  const wall = Temporal.PlainDateTime.from(`${remindDate}T${remindTime}`);
  const zoned = wall.toZonedDateTime(timezone, { disambiguation: 'compatible' });
  return new Date(zoned.epochMilliseconds);
}

/**
 * Compute the snoozed-until instant from a duration keyword.
 * Snooze options from the spec §14.4:
 * - 10min: now + 10 minutes
 * - 1h: now + 1 hour
 * - evening: today at 18:00 (or tomorrow if already past)
 * - tomorrow_morning: tomorrow at 09:00
 */
export function computeSnoozeUntil(
  duration: '10min' | '1h' | 'evening' | 'tomorrow_morning',
  timezone: string,
  now = new Date(),
): Date {
  const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
  const local = instant.toZonedDateTimeISO(timezone);

  switch (duration) {
    case '10min':
      return new Date(local.add({ minutes: 10 }).epochMilliseconds);
    case '1h':
      return new Date(local.add({ hours: 1 }).epochMilliseconds);
    case 'evening': {
      let evening = local.toPlainDate().toZonedDateTime({
        timeZone: timezone,
        plainTime: Temporal.PlainTime.from('18:00'),
      });
      if (Temporal.ZonedDateTime.compare(evening, local) <= 0) {
        evening = local
          .toPlainDate()
          .add({ days: 1 })
          .toZonedDateTime({
            timeZone: timezone,
            plainTime: Temporal.PlainTime.from('18:00'),
          });
      }
      return new Date(evening.epochMilliseconds);
    }
    case 'tomorrow_morning': {
      const morning = local
        .toPlainDate()
        .add({ days: 1 })
        .toZonedDateTime({
          timeZone: timezone,
          plainTime: Temporal.PlainTime.from('09:00'),
        });
      return new Date(morning.epochMilliseconds);
    }
  }
}

