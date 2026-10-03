import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { commandSchema, type RecordItem } from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';
import { newId, type LocalStore } from './store';

export function ProjectNotesScreen({
  project,
  records,
  pendingIds,
  store,
  onClose,
  onSaved,
  onOpenNote,
}: {
  project: RecordItem;
  records: RecordItem[];
  pendingIds: string[];
  store: LocalStore;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onOpenNote: (note: RecordItem) => void;
}) {
  const [selected, setSelected] = useState(project.relatedNoteIds);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty =
    selected.length !== project.relatedNoteIds.length ||
    selected.some((id) => !project.relatedNoteIds.includes(id));
  const pending = (record: RecordItem) => !record.version || pendingIds.includes(record.id);
  const notes = records
    .filter(
      (record) => record.type === 'note' && (!record.deletedAt || selected.includes(record.id)),
    )
    .filter((record) => record.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort(
      (a, b) =>
        Number(selected.includes(b.id)) - Number(selected.includes(a.id)) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const missing = selected.filter((id) => !records.some((record) => record.id === id));
  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }
  async function save() {
    if (saving || pending(project)) return;
    const parsed = commandSchema.safeParse({
      op: 'project.setNotes',
      id: project.id,
      baseVersion: project.version,
      noteIds: [...selected].sort(),
    });
    if (!parsed.success || parsed.data.op !== 'project.setNotes') {
      setError('Choose up to 100 notes.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await store.enqueue(
        { mutationId: newId(), command: parsed.data },
        { ...project, relatedNoteIds: parsed.data.noteIds },
        project,
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
        <Text style={styles.eyebrow}>RELATED NOTES</Text>
        <Text style={styles.title}>{project.text}</Text>
        <Text style={styles.subtitle}>
          Keep useful notes with this project. Removing a link keeps the note in your library.
        </Text>
        <Text style={styles.label}>{selected.length} of 100 selected</Text>
        {dirty && (
          <Text style={styles.subtitle}>
            Save your links before opening a note. Closing discards unsaved link changes.
          </Text>
        )}
        <View style={styles.row}>
          <Button
            label={saving ? 'Saving…' : 'Save links'}
            disabled={saving || pending(project)}
            onPress={() => void save()}
          />
          <Button secondary label="Close" disabled={saving} onPress={onClose} />
        </View>
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <Field label="Find a note" value={query} onChangeText={setQuery} editable={!saving} />
        {!notes.length && (
          <Text style={styles.subtitle}>
            {query ? 'No matching notes.' : 'Create a note in your library to link it here.'}
          </Text>
        )}
        {notes.map((note) => {
          const linked = selected.includes(note.id);
          return (
            <Card key={note.id}>
              <Text style={styles.label}>{note.text.split('\n')[0] || 'Untitled note'}</Text>
              <Text style={styles.subtitle}>
                {note.deletedAt ? 'In Trash' : note.status === 'archived' ? 'Archived' : 'Note'}
                {pending(note) ? ' · Sync pending' : ''}
              </Text>
              <View style={styles.row}>
                <Button
                  secondary={!linked}
                  label={linked ? 'Remove link' : 'Link note'}
                  disabled={
                    saving ||
                    pending(project) ||
                    (!linked && (pending(note) || selected.length >= 100 || !!note.deletedAt))
                  }
                  onPress={() => toggle(note.id)}
                />
                <Button
                  secondary
                  label="Open note"
                  disabled={saving || dirty || !!note.deletedAt || pending(note)}
                  onPress={() => onOpenNote(note)}
                />
              </View>
            </Card>
          );
        })}
        {missing.map((id) => (
          <Card key={id}>
            <Text style={styles.subtitle}>
              Linked note unavailable on this device. Sync to load it.
            </Text>
            <Button
              secondary
              label="Remove link"
              disabled={saving || pending(project)}
              onPress={() => toggle(id)}
            />
          </Card>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
