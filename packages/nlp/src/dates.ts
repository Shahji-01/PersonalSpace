export type TaskDates = { plannedDate?: string; dueDate?: string; needsDateReview: boolean };
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const shortDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function offset(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Calendar arithmetic uses the caller's local date, never the server's timezone.
// These are reviewable suggestions; the original capture text is always retained.
export function parseTaskDates(text: string, today: string): TaskDates {
  if (!calendarDate(today)) throw new Error('A valid local date is required.');
  const input = text.toLowerCase().normalize('NFC');
  let needsDateReview =
    /(?<![\p{L}\p{M}])(?:kal|परसों|कल)(?![\p{L}\p{M}])|\b\d{1,2}\/\d{1,2}\b/u.test(input);
  if (/\b(?:every|each|daily|weekly|monthly)\b|हर|रोज़/u.test(input))
    return { needsDateReview: true };
  const planned = new Set<string>();
  const due = new Set<string>();
  const pattern =
    /(?<![\p{L}\p{M}\p{N}])(?:\d{4}-\d{2}-\d{2}|day after tomorrow|tomorrow|today|aaj|आज|in a week|next week|agle hafte|अगले हफ्ते|this weekend|weekend|end of (?:the )?month|month ?end|in \d{1,3} days?|(?:next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat))(?![\p{L}\p{M}\p{N}])/gu;
  for (const match of input.matchAll(pattern)) {
    const token = match[0];
    let date: string;
    if (/^\d{4}/.test(token)) {
      if (!calendarDate(token)) {
        needsDateReview = true;
        continue;
      }
      date = token;
    } else if (['today', 'aaj', 'आज'].includes(token)) date = today;
    else if (token === 'tomorrow') date = offset(today, 1);
    else if (token === 'day after tomorrow') date = offset(today, 2);
    else if (['in a week', 'next week', 'agle hafte', 'अगले हफ्ते'].includes(token))
      date = offset(today, 7);
    else if (token === 'this weekend' || token === 'weekend') {
      // The coming Saturday; if today is Saturday, keep today.
      const current = new Date(`${today}T12:00:00Z`).getUTCDay();
      date = offset(today, (6 - current + 7) % 7);
    } else if (['end of month', 'end of the month', 'month end', 'monthend'].includes(token)) {
      const d = new Date(`${today}T12:00:00Z`);
      date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
        .toISOString()
        .slice(0, 10);
    } else if (token.startsWith('in ')) date = offset(today, Number(token.match(/\d+/)![0]));
    else {
      const day = token.replace('next ', '');
      const weekday = Math.max(weekdays.indexOf(day), shortDays.indexOf(day));
      const current = new Date(`${today}T12:00:00Z`).getUTCDay();
      const delta = (weekday - current + 7) % 7;
      date = offset(today, delta === 0 && token.startsWith('next ') ? 7 : delta);
    }
    const before = input.slice(0, match.index);
    const after = input.slice(match.index! + token.length);
    const deadline =
      /(?:\bdue(?:\s+on)?|\bdeadline(?:\s+is|\s+on)?|\bby|अंतिम तारीख)\s*:?\s*$/u.test(before) ||
      /^\s*(?:tak\b|तक)/u.test(after);
    (deadline ? due : planned).add(date);
  }
  if (planned.size > 1 || due.size > 1) needsDateReview = true;
  return {
    ...(planned.size === 1 ? { plannedDate: [...planned][0]! } : {}),
    ...(due.size === 1 ? { dueDate: [...due][0]! } : {}),
    needsDateReview,
  };
}
