import { describe, expect, it } from 'vitest';
import { suggestCapture, parseTaskDates } from './index';
describe('capture suggestions', () => {
  it('separates do dates from deadline cues without removing the original text', () => {
    expect(parseTaskDates('Task write proposal tomorrow, due Friday', '2026-10-01')).toEqual({
      plannedDate: '2026-10-02',
      dueDate: '2026-10-02',
      needsDateReview: false,
    });
    expect(parseTaskDates('Send proposal today, by 2026-10-08', '2026-10-01')).toEqual({
      plannedDate: '2026-10-01',
      dueDate: '2026-10-08',
      needsDateReview: false,
    });
    expect(parseTaskDates('Read by tomorrow', '2026-10-01')).toEqual({
      dueDate: '2026-10-02',
      needsDateReview: false,
    });
    expect(suggestCapture('Report bhejna aaj, Friday tak', '2026-10-01')).toMatchObject({
      type: 'task',
      dates: { plannedDate: '2026-10-01', dueDate: '2026-10-02' },
    });
    expect(suggestCapture('आज रिपोर्ट भेजना', '2026-10-01')).toMatchObject({
      type: 'task',
      dates: { plannedDate: '2026-10-01' },
    });
  });
  it('uses calendar arithmetic across leap years, DST dates and year boundaries', () => {
    for (const [today, expected] of [
      ['2024-02-28', '2024-02-29'],
      ['2026-03-08', '2026-03-09'],
      ['2026-11-01', '2026-11-02'],
      ['2026-12-31', '2027-01-01'],
    ])
      expect(parseTaskDates('Call tomorrow', today!).plannedDate).toBe(expected);
    expect(parseTaskDates('Read in 3 days', '2026-12-30').plannedDate).toBe('2027-01-02');
    expect(parseTaskDates('Read next Monday', '2026-10-05').plannedDate).toBe('2026-10-12');
    expect(parseTaskDates('Read Monday', '2026-10-05').plannedDate).toBe('2026-10-05');
  });
  it('leaves ambiguous, invalid and repeating dates for review and avoids questions', () => {
    for (const text of [
      'Call kal',
      'Call कल',
      'Call 03/04',
      'Read 2026-02-30',
      'Read every Monday',
      'Read today and tomorrow',
    ])
      expect(parseTaskDates(text, '2026-10-01').needsDateReview).toBe(true);
    expect(parseTaskDates('Read today and tomorrow', '2026-10-01').plannedDate).toBeUndefined();
    expect(parseTaskDates('Read every Monday', '2026-10-01').plannedDate).toBeUndefined();
    expect(suggestCapture('Kya report bhejna hai?', '2026-10-01').type).toBe('inbox');
    expect(suggestCapture('क्या आज कॉल करना है?', '2026-10-01').type).toBe('inbox');
    expect(() => parseTaskDates('Call tomorrow', '2026-02-30')).toThrow();
  });
  it('does not turn a question or an expense into a task', () => {
    expect(suggestCapture('Did I buy milk?').type).toBe('inbox');
    expect(suggestCapture('Spent 450 on groceries').type).toBe('inbox');
  });
  it('suggests an explicit task without saving it', () =>
    expect(suggestCapture('Call Mom').type).toBe('task'));
  it('preserves links and long text in inbox', () => {
    expect(suggestCapture('https://example.com/task').type).toBe('inbox');
    expect(suggestCapture('Read ' + 'a'.repeat(500)).type).toBe('inbox');
  });
});
