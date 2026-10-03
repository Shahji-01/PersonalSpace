import {
  currentTimeZone,
  deadlineInstant,
  deadlineLocalDate,
  type RecordItem,
} from '@personalspace/validation';

export type TaskView =
  'today' | 'upcoming7' | 'upcoming30' | 'overdue' | 'all' | 'completed' | 'archived';
export const taskViews: { value: TaskView; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'upcoming7', label: 'Next 7 days' },
  { value: 'upcoming30', label: 'Next 30 days' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'all', label: 'All tasks' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
];
export const taskIsClosed = (record: RecordItem) =>
  record.status === 'done' || record.status === 'cancelled';

function offsetDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function taskIsOverdue(
  record: RecordItem,
  today: string,
  now = new Date(),
  zone = currentTimeZone(),
) {
  if (
    record.type !== 'task' ||
    record.deletedAt ||
    record.archivedAt ||
    taskIsClosed(record) ||
    !record.dueDate
  )
    return false;
  const instant = deadlineInstant(record, zone);
  return instant ? new Date(instant).getTime() <= now.getTime() : record.dueDate < today;
}
export function taskMatches(
  record: RecordItem,
  view: TaskView,
  today: string,
  now = new Date(),
  zone = currentTimeZone(),
) {
  if (record.type !== 'task' || record.parentId || record.deletedAt) return false;
  if (view === 'archived') return !!record.archivedAt;
  if (record.archivedAt) return false;
  if (view === 'all') return true;
  if (view === 'completed')
    return (
      record.status === 'done' &&
      new Date(record.completedAt ?? record.updatedAt).getTime() >=
        new Date(`${offsetDate(today, -29)}T00:00:00`).getTime()
    );
  const overdue = taskIsOverdue(record, today, now, zone);
  const dueDate = deadlineLocalDate(record, zone);
  if (view === 'today') return record.plannedDate === today || dueDate === today || overdue;
  if (view === 'overdue') return overdue;
  if (taskIsClosed(record)) return false;
  const end = offsetDate(today, view === 'upcoming7' ? 6 : 29);
  return [record.plannedDate, dueDate].some(
    (date) => date !== null && date >= today && date <= end,
  );
}
