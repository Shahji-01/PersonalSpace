import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import {
  firstOccurrence,
  nextOccurrence,
  recurrenceSetupSchema,
  recurrenceRRule,
  recurringInstant,
} from './recurrence';
const setup = (patch: Record<string, unknown> = {}) =>
  recurrenceSetupSchema.parse({
    frequency: 'DAILY',
    interval: 1,
    weekdays: [],
    lastDay: false,
    mode: 'fixed_schedule',
    anchorDate: '2026-01-01',
    anchorTime: null,
    timeMode: 'floating',
    timezone: 'Asia/Kolkata',
    endsOn: null,
    count: null,
    ...patch,
  });
describe('shared RRULE expansion', () => {
  it('handles selected weekdays, month-end skipping, last days, leap years and finite series', () => {
    const weekly = setup({ frequency: 'WEEKLY', weekdays: [0, 4] });
    expect(firstOccurrence(weekly)).toBe('2026-01-02');
    expect(nextOccurrence(weekly, '2026-01-02', 1, '2026-02-01T00:00:00Z', 'UTC')).toBe(
      '2026-01-05',
    );
    const monthly = setup({ frequency: 'MONTHLY', anchorDate: '2026-01-31' });
    expect(nextOccurrence(monthly, '2026-01-31', 1, '2026-02-01T00:00:00Z', 'UTC')).toBe(
      '2026-03-31',
    );
    expect(
      nextOccurrence({ ...monthly, lastDay: true }, '2026-01-31', 1, '2026-02-01T00:00:00Z', 'UTC'),
    ).toBe('2026-02-28');
    expect(
      nextOccurrence(
        setup({ frequency: 'YEARLY', anchorDate: '2024-02-29' }),
        '2024-02-29',
        1,
        '2026-02-01T00:00:00Z',
        'UTC',
      ),
    ).toBe('2028-02-29');
    expect(
      nextOccurrence(setup({ count: 1 }), '2026-01-01', 1, '2026-02-01T00:00:00Z', 'UTC'),
    ).toBeNull();
    expect(
      nextOccurrence(
        setup({ endsOn: '2026-01-01' }),
        '2026-01-01',
        1,
        '2026-02-01T00:00:00Z',
        'UTC',
      ),
    ).toBeNull();
    expect(recurrenceRRule(weekly)).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR');
    expect(() => setup({ endsOn: '2026-01-31', count: 5 })).toThrow();
  });
  it('uses the completion day in the correct timezone and applies compatible DST resolution', () => {
    const floating = setup({ mode: 'after_completion', interval: 3 });
    const finished = '2026-01-01T23:30:00Z';
    expect(nextOccurrence(floating, '2026-01-01', 1, finished, 'Asia/Kolkata')).toBe('2026-01-05');
    expect(nextOccurrence(floating, '2026-01-01', 1, finished, 'America/Los_Angeles')).toBe(
      '2026-01-04',
    );
    expect(
      nextOccurrence(
        { ...floating, timeMode: 'fixed' },
        '2026-01-01',
        1,
        finished,
        'America/Los_Angeles',
      ),
    ).toBe('2026-01-05');
    expect(recurringInstant('2026-03-08', '02:30', 'fixed', 'America/New_York')).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    expect(recurringInstant('2026-11-01', '01:30', 'fixed', 'America/New_York')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(recurringInstant('2026-01-01', '17:00', 'floating', 'Asia/Kolkata')).toBeNull();
  });
  it('maintains monotonic, unique occurrences and timezone round trips across generated calendars', () => {
    for (const year of [2024, 2025, 2026, 2028])
      for (const month of [1, 2, 3, 10, 11, 12])
        for (const interval of [1, 2, 7]) {
          const anchor = `${year}-${String(month).padStart(2, '0')}-15`;
          const rule = setup({
            frequency: 'WEEKLY',
            interval,
            anchorDate: anchor,
            weekdays: [0, 2, 4],
            count: 12,
          });
          let day = firstOccurrence(rule)!;
          const seen = new Set<string>();
          for (let index = 1; index <= 12; index++) {
            expect(seen.has(day)).toBe(false);
            seen.add(day);
            expect([1, 3, 5]).toContain(Temporal.PlainDate.from(day).dayOfWeek);
            for (const timezone of ['Asia/Kolkata', 'America/New_York', 'Australia/Lord_Howe']) {
              const instant = recurringInstant(day, '12:00', 'fixed', timezone)!;
              const local = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone);
              expect(local.toPlainDate().toString()).toBe(day);
              expect(local.hour).toBe(12);
            }
            const next = nextOccurrence(rule, day, index, '2026-01-01T00:00:00Z', 'UTC');
            if (index === 12) expect(next).toBeNull();
            else {
              expect(next! > day).toBe(true);
              day = next!;
            }
          }
        }
  });
});
