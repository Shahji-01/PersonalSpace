import { useState } from 'react';
import { Text, View } from 'react-native';
import {
  commandSchema,
  currentTimeZone,
  deadlineLabel,
  fixedDeadlineInstant,
  type Deadline,
  type RecordItem,
} from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';
import { newId, type LocalStore } from './store';

export function DeadlineForm({
  task,
  store,
  onSaved,
  saving,
  onSavingChange,
}: {
  task: RecordItem;
  store: LocalStore;
  onSaved: () => Promise<void>;
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
}) {
  const [date, setDate] = useState(task.dueDate ?? '');
  const [time, setTime] = useState(task.dueTime ?? '');
  const [mode, setMode] = useState(task.timeMode);
  const [zone, setZone] = useState(task.timezone ?? currentTimeZone());
  const [occurrence, setOccurrence] = useState<Deadline['occurrence']>(() => {
    if (task.timeMode !== 'fixed' || !task.dueAt) return null;
    try {
      return fixedDeadlineInstant({ ...task, occurrence: 'earlier' }) === task.dueAt
        ? 'earlier'
        : 'later';
    } catch {
      return null;
    }
  });
  const [error, setError] = useState('');
  const [ambiguous, setAmbiguous] = useState(false);
  const deadline: Deadline = {
    dueDate: date.trim() || null,
    dueTime: time.trim() || null,
    timeMode: time.trim() ? mode : 'floating',
    timezone: time.trim() ? (mode === 'floating' ? currentTimeZone() : zone.trim()) : null,
    occurrence: time.trim() && mode === 'fixed' ? occurrence : null,
  };
  function changed() {
    setOccurrence(null);
    setAmbiguous(false);
    setError('');
  }
  async function save() {
    if (saving) return;
    const parsed = commandSchema.safeParse({
      op: 'task.setDeadline',
      id: task.id,
      baseVersion: task.version,
      deadline,
    });
    if (!parsed.success || parsed.data.op !== 'task.setDeadline') {
      setError(
        parsed.success
          ? 'Check the deadline.'
          : (parsed.error.issues[0]?.message ?? 'Check the deadline.'),
      );
      return;
    }
    let dueAt: string | null;
    try {
      dueAt = fixedDeadlineInstant(parsed.data.deadline);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Check the timezone.');
      setAmbiguous(error instanceof Error && 'code' in error && error.code === 'AMBIGUOUS_TIME');
      return;
    }
    onSavingChange(true);
    setError('');
    try {
      const { dueDate, dueTime, timeMode, timezone } = parsed.data.deadline;
      await store.enqueue(
        { mutationId: newId(), command: parsed.data },
        { ...task, dueDate, dueTime, timeMode, timezone, dueAt },
        task,
      );
      await onSaved();
    } catch {
      setError('Could not save. Wait for pending changes to sync and try again.');
    } finally {
      onSavingChange(false);
    }
  }
  return (
    <Card>
      <Text style={styles.label}>Deadline</Text>
      <Text style={styles.subtitle}>{deadlineLabel(task)}</Text>
      <Field
        label="Deadline date"
        value={date}
        onChangeText={(value) => {
          setDate(value);
          changed();
        }}
        placeholder="YYYY-MM-DD"
        maxLength={10}
        editable={!saving}
      />
      <Field
        label="Time (optional)"
        value={time}
        onChangeText={(value) => {
          setTime(value);
          changed();
        }}
        placeholder="HH:mm, for example 17:30"
        maxLength={5}
        keyboardType="numbers-and-punctuation"
        editable={!saving}
      />
      {time !== '' && (
        <>
          <View style={styles.row}>
            <Button
              secondary={mode !== 'floating'}
              label="Local time"
              disabled={saving}
              onPress={() => {
                setMode('floating');
                changed();
              }}
            />
            <Button
              secondary={mode !== 'fixed'}
              label="Fixed timezone"
              disabled={saving}
              onPress={() => {
                setMode('fixed');
                changed();
              }}
            />
          </View>
          {mode === 'fixed' ? (
            <>
              <Field
                label="Timezone"
                value={zone}
                onChangeText={(value) => {
                  setZone(value);
                  changed();
                }}
                maxLength={100}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Asia/Kolkata"
                editable={!saving}
              />
              <Text style={styles.subtitle}>Keeps the same instant when you travel.</Text>
            </>
          ) : (
            <Text style={styles.subtitle}>
              Follows your current timezone ({currentTimeZone()}). On a clock change, the first
              repeated time is used and a skipped time moves forward.
            </Text>
          )}
        </>
      )}
      {ambiguous && (
        <View style={styles.row}>
          <Button
            secondary={occurrence !== 'earlier'}
            label="First occurrence"
            onPress={() => setOccurrence('earlier')}
            disabled={saving}
          />
          <Button
            secondary={occurrence !== 'later'}
            label="Second occurrence"
            onPress={() => setOccurrence('later')}
            disabled={saving}
          />
        </View>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <View style={styles.row}>
        <Button
          label={saving ? 'Saving…' : 'Save deadline'}
          disabled={saving}
          onPress={() => void save()}
        />
        <Button
          secondary
          label="Clear fields"
          disabled={saving}
          onPress={() => {
            setDate('');
            setTime('');
            changed();
          }}
        />
      </View>
    </Card>
  );
}
