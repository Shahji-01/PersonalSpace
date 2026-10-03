import { describe, expect, it } from 'vitest';
import {
  deadlineSchema,
  fixedDeadlineInstant,
  deadlineInstant,
  deadlineLocalDate,
  deadlineLabel,
} from './time';

const fixed = (
  dueDate: string,
  dueTime: string,
  timezone: string,
  occurrence: 'earlier' | 'later' | null = null,
) => deadlineSchema.parse({ dueDate, dueTime, timezone, timeMode: 'fixed', occurrence });
describe('deadline time intent', () => {
  it('validates date/time/zone combinations and rejects offsets and invalid wall times', () => {
    for (const input of [
      { dueDate: null, dueTime: '12:00', timeMode: 'floating', timezone: 'Asia/Kolkata' },
      { dueDate: '2026-10-02', dueTime: '24:00', timeMode: 'fixed', timezone: 'UTC' },
      { dueDate: '2026-10-02', dueTime: '12:00', timeMode: 'fixed', timezone: '+05:30' },
      { dueDate: '2026-10-02', dueTime: '12:00', timeMode: 'fixed', timezone: 'Not/AZone' },
      { dueDate: '2026-10-02', dueTime: null, timeMode: 'fixed', timezone: 'UTC' },
    ])
      expect(deadlineSchema.safeParse(input).success).toBe(false);
    expect(fixedDeadlineInstant(fixed('2026-10-02', '17:30', 'Asia/Kolkata'))).toBe(
      '2026-10-02T12:00:00.000Z',
    );
  });
  it('requires a choice for a repeated fixed time and rejects gaps including half-hour transitions', () => {
    expect(() => fixedDeadlineInstant(fixed('2026-11-01', '01:30', 'America/New_York'))).toThrow(
      'first or second',
    );
    expect(fixedDeadlineInstant(fixed('2026-11-01', '01:30', 'America/New_York', 'earlier'))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(fixedDeadlineInstant(fixed('2026-11-01', '01:30', 'America/New_York', 'later'))).toBe(
      '2026-11-01T06:30:00.000Z',
    );
    expect(() => fixedDeadlineInstant(fixed('2026-03-08', '02:30', 'America/New_York'))).toThrow(
      'does not exist',
    );
    expect(() =>
      fixedDeadlineInstant(fixed('2026-10-04', '02:15', 'Australia/Lord_Howe', 'later')),
    ).toThrow('does not exist');
  });
  it('keeps a fixed instant across travel and moves floating deadlines with the current zone', () => {
    const wall = fixed('2026-10-02', '00:30', 'Asia/Kolkata');
    const record = { ...wall, dueAt: fixedDeadlineInstant(wall) };
    expect(deadlineInstant(record, 'America/Los_Angeles')).toBe('2026-10-01T19:00:00.000Z');
    expect(deadlineLocalDate(record, 'America/Los_Angeles')).toBe('2026-10-01');
    expect(deadlineLabel(record, 'America/Los_Angeles')).toContain('2026-10-01 12:00');
    const floating = { ...record, timeMode: 'floating' as const, dueAt: null };
    expect(deadlineInstant(floating, 'Asia/Kolkata')).toBe('2026-10-01T19:00:00.000Z');
    expect(deadlineInstant(floating, 'America/Los_Angeles')).toBe('2026-10-02T07:30:00.000Z');
    expect(deadlineLocalDate(floating, 'America/Los_Angeles')).toBe('2026-10-02');
    expect(
      deadlineInstant({ ...floating, dueDate: '2026-03-08', dueTime: '02:30' }, 'America/New_York'),
    ).toBe('2026-03-08T07:30:00.000Z');
  });
  it('round-trips ordinary wall times across zones and the full calendar year', () => {
    for (const zone of [
      'UTC',
      'Asia/Kolkata',
      'Asia/Kathmandu',
      'America/New_York',
      'Europe/Berlin',
      'Australia/Lord_Howe',
      'Pacific/Auckland',
    ]) {
      for (let month = 1; month <= 12; month++) {
        const date = `2026-${String(month).padStart(2, '0')}-15`;
        const input = fixed(date, '12:45', zone);
        const record = { ...input, dueAt: fixedDeadlineInstant(input) };
        expect(deadlineLocalDate(record, zone)).toBe(date);
        expect(deadlineLabel(record, zone)).toContain(`${date} 12:45`);
      }
    }
  });
});
