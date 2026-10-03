import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { commandSchema, type RecordItem } from '@personalspace/validation';
import { Button, Field, styles } from './components';
import { NotePreview } from './NotePreview';
import { DeadlineForm } from './DeadlineForm';
import { RecurrenceForm } from './RecurrenceForm';
import { newId, type LocalStore } from './store';

export function TaskDetailsScreen({
  task,
  store,
  onClose,
  onSaved,
  onEditDescription,
}: {
  task: RecordItem;
  store: LocalStore;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onEditDescription: () => void;
}) {
  const [minutes, setMinutes] = useState(task.estimatedMinutes?.toString() ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function saveEstimate() {
    if (saving) return;
    const parsed = commandSchema.safeParse({
      op: 'task.setEstimate',
      id: task.id,
      baseVersion: task.version,
      estimatedMinutes:
        minutes.trim() === '' ? null : /^\d+$/.test(minutes.trim()) ? Number(minutes) : NaN,
    });
    if (!parsed.success || parsed.data.op !== 'task.setEstimate') {
      setError('Enter whole minutes from 1 to 525600, or leave blank to remove the estimate.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await store.enqueue(
        { mutationId: newId(), command: parsed.data },
        { ...task, estimatedMinutes: parsed.data.estimatedMinutes },
        task,
      );
      await onSaved();
    } catch {
      setError('Could not save. Wait for pending changes to sync and try again.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Text style={styles.eyebrow}>TASK DETAILS</Text>
        <Text style={styles.title}>{task.text}</Text>
        <Text style={styles.label}>Description</Text>
        {task.descriptionJson ? (
          <NotePreview document={task.descriptionJson} />
        ) : (
          <Text style={styles.subtitle}>Add steps, context, checklists or links.</Text>
        )}
        <Button secondary label="Edit description" disabled={saving} onPress={onEditDescription} />
        <DeadlineForm
          task={task}
          store={store}
          onSaved={onSaved}
          saving={saving}
          onSavingChange={setSaving}
        />
        <RecurrenceForm
          task={task}
          store={store}
          saving={saving}
          onSavingChange={setSaving}
          onSaved={onSaved}
        />
        <Field
          label="Estimated minutes"
          value={minutes}
          onChangeText={setMinutes}
          keyboardType="number-pad"
          placeholder="Optional"
          maxLength={6}
          editable={!saving}
        />
        <View style={styles.row}>
          {[15, 30, 60, 120].map((value) => (
            <Button
              key={value}
              secondary
              label={`${value} min`}
              disabled={saving}
              onPress={() => setMinutes(String(value))}
            />
          ))}
          <Button
            secondary
            label="Clear estimate"
            disabled={saving}
            onPress={() => setMinutes('')}
          />
        </View>
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <Button
          label={saving ? 'Saving…' : 'Save estimate'}
          disabled={saving}
          onPress={() => void saveEstimate()}
        />
        <Button secondary label="Close" disabled={saving} onPress={onClose} />
      </ScrollView>
    </SafeAreaView>
  );
}
