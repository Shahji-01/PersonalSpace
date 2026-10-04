import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  commandSchema,
  recordSchema,
  type Command,
  type RecordItem,
} from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';
import { newId, type LocalStore } from './store';

const deviceTimezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

const statusLabel: Record<string, string> = {
  scheduled: 'Scheduled',
  snoozed: 'Snoozed',
  fired: 'Fired',
  done: 'Done',
  dismissed: 'Dismissed',
  cancelled: 'Cancelled',
};

export function RemindersScreen({
  records,
  pendingIds,
  store,
  onClose,
  onChanged,
}: {
  records: RecordItem[];
  pendingIds: string[];
  store: LocalStore;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(today);
  const [time, setTime] = useState('09:00');
  const [timeMode, setTimeMode] = useState<'floating' | 'fixed'>('floating');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reminders = records
    .filter((r) => r.type === 'reminder' && !r.deletedAt)
    .sort((a, b) => (a.fireAt ?? a.remindDate ?? '').localeCompare(b.fireAt ?? b.remindDate ?? ''));
  const pending = (record: RecordItem) => !record.version || pendingIds.includes(record.id);

  async function enqueue(command: Command, optimistic?: RecordItem, previous?: RecordItem) {
    if (saving) return;
    const parsed = commandSchema.safeParse(command);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the reminder details.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await store.enqueue({ mutationId: newId(), command: parsed.data }, optimistic, previous);
      await onChanged();
    } catch {
      setError('Could not save. Wait for pending changes to sync and try again.');
    } finally {
      setSaving(false);
    }
  }

  function create() {
    const id = newId();
    const now = new Date().toISOString();
    void enqueue(
      {
        op: 'reminder.create',
        id,
        entityId: null,
        title: title.trim(),
        remindDate: date,
        remindTime: time,
        timeMode,
        timezone: deviceTimezone,
      },
      recordSchema.parse({
        id,
        type: 'reminder',
        text: title.trim() || 'Reminder',
        status: 'scheduled',
        remindDate: date,
        remindTime: time,
        timeMode,
        timezone: deviceTimezone,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    );
    setTitle('');
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>REMINDERS</Text>
        <Text style={styles.title}>Nudge yourself.</Text>
        <Text style={styles.subtitle}>
          Floating reminders follow your current timezone; fixed reminders keep the same instant
          when you travel.
        </Text>
        <Button secondary label="Close" disabled={saving} onPress={onClose} />
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <Card>
          <Field
            label="What should I remind you about?"
            value={title}
            onChangeText={setTitle}
            maxLength={500}
          />
          <Field
            label="Date (YYYY-MM-DD)"
            value={date}
            onChangeText={setDate}
            autoCapitalize="none"
          />
          <Field
            label="Time (HH:MM, 24-hour)"
            value={time}
            onChangeText={setTime}
            autoCapitalize="none"
          />
          <View style={styles.row}>
            <Button
              secondary={timeMode !== 'floating'}
              label="Floating"
              onPress={() => setTimeMode('floating')}
            />
            <Button
              secondary={timeMode !== 'fixed'}
              label="Fixed"
              onPress={() => setTimeMode('fixed')}
            />
          </View>
          <Button
            label={saving ? 'Saving…' : 'Add reminder'}
            disabled={saving || !title.trim()}
            onPress={create}
          />
        </Card>

        {!reminders.length && <Text style={styles.subtitle}>No reminders yet.</Text>}
        {reminders.map((r) => (
          <Card key={r.id}>
            <Text style={styles.label}>{r.text || 'Reminder'}</Text>
            <Text style={styles.subtitle}>
              {r.remindDate} {r.remindTime}
              {' · '}
              {statusLabel[r.status] ?? r.status}
              {r.timeMode === 'fixed' ? ' · fixed' : ''}
              {pending(r) ? ' · Sync pending' : ''}
            </Text>
            <View style={styles.row}>
              <Button
                secondary
                label="Done"
                disabled={saving || pending(r) || r.status === 'done'}
                onPress={() =>
                  void enqueue(
                    { op: 'reminder.done', id: r.id, baseVersion: r.version },
                    { ...r, status: 'done' },
                    r,
                  )
                }
              />
              <Button
                secondary
                label="Snooze 1h"
                disabled={saving || pending(r)}
                onPress={() =>
                  void enqueue(
                    {
                      op: 'reminder.snooze',
                      id: r.id,
                      duration: '1h',
                      currentTimezone: deviceTimezone,
                      baseVersion: r.version,
                    },
                    { ...r, status: 'snoozed' },
                    r,
                  )
                }
              />
              <Button
                secondary
                label="Dismiss"
                disabled={saving || pending(r) || r.status === 'dismissed'}
                onPress={() =>
                  void enqueue(
                    { op: 'reminder.dismiss', id: r.id, baseVersion: r.version },
                    { ...r, status: 'dismissed' },
                    r,
                  )
                }
              />
              <Button
                secondary
                label="Delete"
                disabled={saving || pending(r)}
                onPress={() =>
                  void enqueue(
                    { op: 'reminder.delete', id: r.id, baseVersion: r.version },
                    { ...r, deletedAt: new Date().toISOString() },
                    r,
                  )
                }
              />
            </View>
          </Card>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
