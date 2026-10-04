import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { commandSchema, type RecordItem } from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';
import { newId, type LocalStore } from './store';

const typeLabels: Record<string, string> = {
  youtube_video: 'YouTube video',
  youtube_playlist: 'YouTube playlist',
  article: 'Article',
  website: 'Website',
  documentation: 'Documentation',
  course: 'Course',
  pdf: 'PDF',
  book: 'Book',
  podcast: 'Podcast',
  other: 'Resource',
};

export function ProjectResourcesScreen({
  project,
  records,
  pendingIds,
  store,
  onClose,
  onSaved,
}: {
  project: RecordItem;
  records: RecordItem[];
  pendingIds: string[];
  store: LocalStore;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(project.relatedResourceIds);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty =
    selected.length !== project.relatedResourceIds.length ||
    selected.some((id) => !project.relatedResourceIds.includes(id));
  const pending = (record: RecordItem) => !record.version || pendingIds.includes(record.id);
  const resources = records
    .filter(
      (record) =>
        record.type === 'learning_resource' && (!record.deletedAt || selected.includes(record.id)),
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
      op: 'project.setResources',
      id: project.id,
      baseVersion: project.version,
      resourceIds: [...selected].sort(),
    });
    if (!parsed.success || parsed.data.op !== 'project.setResources') {
      setError('Choose up to 100 resources.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await store.enqueue(
        { mutationId: newId(), command: parsed.data },
        { ...project, relatedResourceIds: parsed.data.resourceIds },
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
        <Text style={styles.eyebrow}>RELATED RESOURCES</Text>
        <Text style={styles.title}>{project.text}</Text>
        <Text style={styles.subtitle}>
          Keep learning resources with this project. Removing a link keeps the resource in your
          library.
        </Text>
        <Text style={styles.label}>{selected.length} of 100 selected</Text>
        {dirty && <Text style={styles.subtitle}>Closing discards unsaved link changes.</Text>}
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
        <Field label="Find a resource" value={query} onChangeText={setQuery} editable={!saving} />
        {!resources.length && (
          <Text style={styles.subtitle}>
            {query ? 'No matching resources.' : 'Save a learning resource to link it here.'}
          </Text>
        )}
        {resources.map((resource) => {
          const linked = selected.includes(resource.id);
          return (
            <Card key={resource.id}>
              <Text style={styles.label}>{resource.text || 'Untitled resource'}</Text>
              <Text style={styles.subtitle}>
                {resource.deletedAt
                  ? 'In Trash'
                  : (resource.resourceType && typeLabels[resource.resourceType]) || 'Resource'}
                {pending(resource) ? ' · Sync pending' : ''}
              </Text>
              <View style={styles.row}>
                <Button
                  secondary={!linked}
                  label={linked ? 'Remove link' : 'Link resource'}
                  disabled={
                    saving ||
                    pending(project) ||
                    (!linked &&
                      (pending(resource) || selected.length >= 100 || !!resource.deletedAt))
                  }
                  onPress={() => toggle(resource.id)}
                />
              </View>
            </Card>
          );
        })}
        {missing.map((id) => (
          <Card key={id}>
            <Text style={styles.subtitle}>
              Linked resource unavailable on this device. Sync to load it.
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
