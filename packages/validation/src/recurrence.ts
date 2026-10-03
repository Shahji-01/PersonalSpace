import { z } from 'zod';
import * as rrule from 'rrule';
import { Temporal } from '@js-temporal/polyfill';
import { timeZoneSchema, wallTimeSchema } from './time';

// Node loads rrule's CommonJS main; Metro/Vite use its ES module entry.
const { RRule } = (rrule as typeof rrule & { default?: typeof rrule }).default ?? rrule;

export const recurrenceSetupSchema = z
  .strictObject({
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().min(1).max(366),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    lastDay: z.boolean().default(false),
    mode: z.enum(['fixed_schedule', 'after_completion']),
    anchorDate: z.iso.date(),
    anchorTime: wallTimeSchema.nullable(),
    timeMode: z.enum(['floating', 'fixed']),
    timezone: timeZoneSchema,
    endsOn: z.iso.date().nullable(),
    count: z.number().int().min(1).max(10000).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.count && value.endsOn)
      ctx.addIssue({
        code: 'custom',
        message: 'Choose either an end date or an occurrence count.',
      });
    if (value.anchorDate < '1900-01-01')
      ctx.addIssue({ code: 'custom', message: 'Repeating schedules must start in 1900 or later.' });
    if (value.endsOn && value.endsOn < value.anchorDate)
      ctx.addIssue({ code: 'custom', message: 'End date must be on or after the start.' });
    if (new Set(value.weekdays).size !== value.weekdays.length)
      ctx.addIssue({ code: 'custom', message: 'Choose each weekday once.' });
    if (value.weekdays.length && (value.frequency !== 'WEEKLY' || value.mode !== 'fixed_schedule'))
      ctx.addIssue({ code: 'custom', message: 'Weekdays apply to fixed weekly schedules.' });
    if (value.lastDay && (value.frequency !== 'MONTHLY' || value.mode !== 'fixed_schedule'))
      ctx.addIssue({ code: 'custom', message: 'Last day applies to fixed monthly schedules.' });
  });
export type RecurrenceSetup = z.infer<typeof recurrenceSetupSchema>;
const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const calendarDate = (date: string) => new Date(`${date}T12:00:00.000Z`);
export function recurrenceRRule(settings: RecurrenceSetup): string {
  return (
    `FREQ=${settings.frequency};INTERVAL=${settings.interval}` +
    (settings.weekdays.length
      ? `;BYDAY=${[...settings.weekdays]
          .sort()
          .map((day) => days[day])
          .join(',')}`
      : '') +
    (settings.lastDay ? ';BYMONTHDAY=-1' : '') +
    (settings.count ? `;COUNT=${settings.count}` : '') +
    (settings.endsOn ? `;UNTIL=${settings.endsOn.replaceAll('-', '')}T235959Z` : '')
  );
}
function expand(settings: RecurrenceSetup, after: string, inclusive: boolean): string | null {
  const rule = new RRule({
    ...RRule.parseString(recurrenceRRule(settings)),
    dtstart: calendarDate(settings.anchorDate),
  });
  const next = rule.after(calendarDate(after), inclusive);
  const date = next?.toISOString().slice(0, 10) ?? null;
  return date && (!settings.endsOn || date <= settings.endsOn) ? date : null;
}
export function firstOccurrence(settings: RecurrenceSetup): string | null {
  return settings.mode === 'fixed_schedule'
    ? expand(settings, settings.anchorDate, true)
    : settings.anchorDate;
}
export function nextOccurrence(
  settings: RecurrenceSetup,
  scheduledDate: string,
  occurrenceNumber: number,
  completedAt: string,
  currentZone: string,
): string | null {
  if (settings.count && occurrenceNumber >= settings.count) return null;
  if (settings.mode === 'fixed_schedule') return expand(settings, scheduledDate, false);
  const date = Temporal.Instant.from(completedAt)
    .toZonedDateTimeISO(settings.timeMode === 'fixed' ? settings.timezone : currentZone)
    .toPlainDate();
  const unit = { DAILY: 'days', WEEKLY: 'weeks', MONTHLY: 'months', YEARLY: 'years' }[
    settings.frequency
  ];
  const next = date.add({ [unit]: settings.interval }).toString();
  if (next.length !== 10) return null;
  return !settings.endsOn || next <= settings.endsOn ? next : null;
}
export function shiftCalendarDate(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}
export function calendarDayOffset(from: string, to: string): number {
  return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days;
}
export function recurringInstant(
  date: string,
  time: string | null,
  timeMode: 'floating' | 'fixed',
  timezone: string,
): string | null {
  if (!time || timeMode === 'floating') return null;
  return Temporal.PlainDateTime.from(`${date}T${time}`)
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant()
    .toString({ smallestUnit: 'millisecond' });
}
export const recurrenceRecordSchema = z.strictObject({
  ruleId: z.uuidv7(),
  seriesId: z.uuidv7(),
  settings: recurrenceSetupSchema,
  rrule: z.string(),
  occurrenceDate: z.iso.date(),
  occurrenceNumber: z.number().int().positive(),
  nextTaskId: z.uuidv7().nullable(),
  advanced: z.boolean(),
});
export const taskEditOperations = [
  'item.setTags',
  'task.rename',
  'task.reschedule',
  'task.setDueDate',
  'task.setDeadline',
  'task.setPriority',
  'task.updateDescription',
  'task.setEstimate',
  'task.setProject',
] as const;
