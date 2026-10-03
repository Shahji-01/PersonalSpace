import { useState } from 'react';
import { Text, View } from 'react-native';
import {
  commandSchema,
  currentTimeZone,
  firstOccurrence,
  recurrenceSetupSchema,
  type RecordItem,
  type RecurrenceSetup,
} from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';
import { newId, type LocalStore } from './store';
const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

export function RecurrenceForm({
  task,
  store,
  saving,
  onSavingChange,
  onSaved,
}: {
  task: RecordItem;
  store: LocalStore;
  saving: boolean;
  onSavingChange: (value: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const existing = task.recurrence?.settings;
  const [frequency, setFrequency] = useState<RecurrenceSetup['frequency']>(
    existing?.frequency ?? 'WEEKLY',
  );
  const [interval, setInterval] = useState(String(existing?.interval ?? 1));
  const [mode, setMode] = useState<RecurrenceSetup['mode']>(existing?.mode ?? 'fixed_schedule');
  const [weekdays, setWeekdays] = useState(existing?.weekdays ?? []);
  const [lastDay, setLastDay] = useState(existing?.lastDay ?? false);
  const [zoneMode, setZoneMode] = useState<'floating' | 'fixed'>(
    existing?.timeMode ?? task.timeMode,
  );
  const [zone, setZone] = useState(existing?.timezone ?? task.timezone ?? currentTimeZone());
  const [start, setStart] = useState(task.plannedDate ?? task.dueDate ?? localDate());
  const [end, setEnd] = useState(existing?.endsOn ?? '');
  const [count, setCount] = useState(existing?.count ? String(existing.count) : '');
  const [error, setError] = useState('');
  const disabled =
    saving || !!task.recurrence?.advanced || task.status === 'done' || task.status === 'cancelled';
  const settings = recurrenceSetupSchema.safeParse({
    frequency,
    interval: Number(interval),
    mode,
    weekdays: frequency === 'WEEKLY' && mode === 'fixed_schedule' ? weekdays : [],
    lastDay: frequency === 'MONTHLY' && mode === 'fixed_schedule' && lastDay,
    anchorDate: start,
    anchorTime: task.dueTime,
    timeMode: task.dueTime ? task.timeMode : zoneMode,
    timezone: task.dueTime
      ? (task.timezone ?? currentTimeZone())
      : zoneMode === 'fixed'
        ? zone
        : currentTimeZone(),
    endsOn: end || null,
    count: count ? Number(count) : null,
  });
  async function save(remove = false) {
    if (disabled) return;
    if (!remove && !settings.success) {
      setError(settings.error.issues[0]?.message ?? 'Check the schedule.');
      return;
    }
    const parsed = commandSchema.safeParse({
      op: 'task.setRecurrence',
      id: task.id,
      baseVersion: task.version,
      recurrence: remove ? null : settings.success ? settings.data : null,
    });
    if (!parsed.success) {
      setError('Check the schedule.');
      return;
    }
    onSavingChange(true);
    setError('');
    try {
      // Rule/successor identities are allocated by the server. Keep the current
      // record until acknowledgement and show the normal pending indicator.
      await store.enqueue({ mutationId: newId(), command: parsed.data }, task, task);
      await onSaved();
    } catch {
      setError('Could not save this schedule. Wait for pending changes to sync and try again.');
    } finally {
      onSavingChange(false);
    }
  }
  return (
    <Card>
      <Text style={styles.label}>Repeat</Text>
      {task.recurrence && (
        <Text style={styles.subtitle}>
          Occurrence {task.recurrence.occurrenceNumber} · Every {task.recurrence.settings.interval}{' '}
          {
            { DAILY: 'day(s)', WEEKLY: 'week(s)', MONTHLY: 'month(s)', YEARLY: 'year(s)' }[
              task.recurrence.settings.frequency
            ]
          }
        </Text>
      )}
      {!!task.recurrence?.advanced && (
        <Text style={styles.subtitle}>
          This occurrence has already advanced. Change future settings on the next open task.
        </Text>
      )}
      <View style={styles.row}>
        {(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).map((value) => (
          <Button
            key={value}
            label={value.toLowerCase()}
            secondary={frequency !== value}
            disabled={disabled}
            onPress={() => setFrequency(value)}
          />
        ))}
      </View>
      <Field
        label="Every (interval)"
        value={interval}
        onChangeText={setInterval}
        keyboardType="number-pad"
        maxLength={3}
        editable={!disabled}
      />
      <View style={styles.row}>
        <Button
          label="Fixed schedule"
          secondary={mode !== 'fixed_schedule'}
          disabled={disabled}
          onPress={() => setMode('fixed_schedule')}
        />
        <Button
          label="After completion"
          secondary={mode !== 'after_completion'}
          disabled={disabled}
          onPress={() => setMode('after_completion')}
        />
      </View>
      <Text style={styles.subtitle}>
        {mode === 'fixed_schedule'
          ? 'Follows scheduled dates, even when completed late.'
          : 'Starts the interval from the day you finish or skip. Shorter months use their final day.'}
      </Text>
      {frequency === 'WEEKLY' && mode === 'fixed_schedule' && (
        <View style={styles.row}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => (
            <Button
              key={day}
              label={day}
              secondary={!weekdays.includes(index)}
              disabled={disabled}
              onPress={() =>
                setWeekdays((current) =>
                  current.includes(index)
                    ? current.filter((value) => value !== index)
                    : [...current, index],
                )
              }
            />
          ))}
        </View>
      )}
      {frequency === 'MONTHLY' && mode === 'fixed_schedule' && (
        <>
          <Button
            label={lastDay ? 'Last day of month' : 'Use start day of month'}
            secondary={!lastDay}
            disabled={disabled}
            onPress={() => setLastDay(!lastDay)}
          />
          <Text style={styles.subtitle}>
            A fixed day such as the 31st skips months without that day. Last day includes every
            month.
          </Text>
        </>
      )}
      {!task.dueTime && (
        <>
          <Text style={styles.label}>Timezone for completion dates</Text>
          <View style={styles.row}>
            <Button
              label="Follow my timezone"
              secondary={zoneMode !== 'floating'}
              disabled={disabled}
              onPress={() => setZoneMode('floating')}
            />
            <Button
              label="Keep one timezone"
              secondary={zoneMode !== 'fixed'}
              disabled={disabled}
              onPress={() => setZoneMode('fixed')}
            />
          </View>
          {zoneMode === 'fixed' && (
            <Field
              label="Timezone"
              value={zone}
              onChangeText={setZone}
              placeholder="Asia/Kolkata"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!disabled}
            />
          )}
        </>
      )}
      <Field
        label="Start date"
        value={start}
        onChangeText={setStart}
        placeholder="YYYY-MM-DD"
        maxLength={10}
        editable={!disabled}
      />
      <Field
        label="End date (optional)"
        value={end}
        onChangeText={setEnd}
        placeholder="YYYY-MM-DD"
        maxLength={10}
        editable={!disabled}
      />
      <Field
        label="Number of occurrences (optional)"
        value={count}
        onChangeText={setCount}
        keyboardType="number-pad"
        maxLength={5}
        editable={!disabled}
      />
      <Text style={styles.subtitle}>
        Uses the task's deadline time and timezone. Clock gaps move forward; repeated clock times
        use the first occurrence. Up to 100 subtasks are copied to the next task.
      </Text>
      {settings.success && (
        <Text style={styles.subtitle}>
          First planned date: {firstOccurrence(settings.data) ?? 'None before the end date'}
        </Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <Button
        label={task.recurrence ? 'Change this and future' : 'Start repeating'}
        disabled={disabled}
        onPress={() => void save()}
      />
      {task.recurrence && (
        <Button
          secondary
          label="Stop repeating from this task"
          disabled={disabled}
          onPress={() => void save(true)}
        />
      )}
    </Card>
  );
}
