import { useState } from 'react';
import { ScrollView, Text, View, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  commandSchema,
  recordSchema,
  type Command,
  type RecordItem,
  type ResourceType,
  type LearningStatus,
} from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';
import { newId, type LocalStore } from './store';

const types: ResourceType[] = [
  'article',
  'website',
  'youtube_video',
  'course',
  'book',
  'podcast',
  'other',
];
const typeLabel: Record<string, string> = {
  article: 'Article',
  website: 'Website',
  youtube_video: 'YouTube',
  youtube_playlist: 'Playlist',
  course: 'Course',
  book: 'Book',
  podcast: 'Podcast',
  documentation: 'Docs',
  pdf: 'PDF',
  other: 'Other',
};
const statuses: LearningStatus[] = ['want_to_learn', 'in_progress', 'completed'];
const statusLabel: Record<string, string> = {
  saved: 'Saved',
  want_to_learn: 'Want to learn',
  in_progress: 'In progress',
  completed: 'Completed',
  paused: 'Paused',
  archived: 'Archived',
};

export function LearningScreen({
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
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [resourceType, setResourceType] = useState<ResourceType>('article');
  const [collectionName, setCollectionName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const collections = records
    .filter((r) => r.type === 'collection' && !r.deletedAt)
    .sort((a, b) => a.text.localeCompare(b.text));
  const resources = records
    .filter((r) => r.type === 'learning_resource' && !r.deletedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const pending = (record: RecordItem) => !record.version || pendingIds.includes(record.id);
  const collectionName_ = (id: string | null) =>
    id ? (collections.find((c) => c.id === id)?.text ?? 'Collection') : null;

  async function enqueue(command: Command, optimistic?: RecordItem, previous?: RecordItem) {
    if (saving) return;
    const parsed = commandSchema.safeParse(command);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the resource details.');
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

  function saveResource() {
    const id = newId();
    const now = new Date().toISOString();
    const trimmedUrl = url.trim() || null;
    void enqueue(
      {
        op: 'resource.save',
        id,
        url: trimmedUrl,
        title: title.trim() || trimmedUrl || 'Resource',
        resourceType,
        source: 'manual',
        collectionId: null,
        externalId: null,
      },
      recordSchema.parse({
        id,
        type: 'learning_resource',
        text: title.trim() || trimmedUrl || 'Resource',
        status: 'saved',
        url: trimmedUrl,
        resourceType,
        metadataStatus: trimmedUrl ? 'pending' : 'ok',
        progressPercent: 0,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    );
    setUrl('');
    setTitle('');
  }

  function createCollection() {
    const id = newId();
    const now = new Date().toISOString();
    void enqueue(
      { op: 'collection.create', id, name: collectionName.trim(), parentId: null },
      recordSchema.parse({
        id,
        type: 'collection',
        text: collectionName.trim(),
        status: 'active',
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    );
    setCollectionName('');
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>LEARNING</Text>
        <Text style={styles.title}>Save it. Learn it.</Text>
        <Text style={styles.subtitle}>
          Save links or titles, track progress, and organize them into collections. Metadata is
          fetched in the background for URLs.
        </Text>
        <Button secondary label="Close" disabled={saving} onPress={onClose} />
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}

        <Card>
          <Text style={styles.label}>Save a resource</Text>
          <Field label="URL (optional)" value={url} onChangeText={setUrl} autoCapitalize="none" />
          <Field label="Title" value={title} onChangeText={setTitle} maxLength={500} />
          <View style={styles.row}>
            {types.map((t) => (
              <Button
                key={t}
                secondary={resourceType !== t}
                label={typeLabel[t] ?? t}
                onPress={() => setResourceType(t)}
              />
            ))}
          </View>
          <Button
            label={saving ? 'Saving…' : 'Save resource'}
            disabled={saving || (!title.trim() && !url.trim())}
            onPress={saveResource}
          />
        </Card>

        <Card>
          <Text style={styles.label}>Collections</Text>
          <View style={styles.row}>
            <Field
              label="New collection"
              value={collectionName}
              onChangeText={setCollectionName}
              maxLength={200}
            />
            <Button
              label="Add"
              disabled={saving || !collectionName.trim()}
              onPress={createCollection}
            />
          </View>
          {collections.map((c) => (
            <View key={c.id} style={styles.row}>
              <Text style={[styles.subtitle, { flex: 1 }]}>{c.text}</Text>
              <Button
                secondary
                label="Delete"
                disabled={saving || pending(c)}
                onPress={() =>
                  void enqueue(
                    { op: 'collection.delete', id: c.id, baseVersion: c.version },
                    { ...c, deletedAt: new Date().toISOString() },
                    c,
                  )
                }
              />
            </View>
          ))}
        </Card>

        {!resources.length && <Text style={styles.subtitle}>No resources yet.</Text>}
        {resources.map((r) => (
          <Card key={r.id}>
            <Text style={styles.label}>{r.text || 'Resource'}</Text>
            <Text style={styles.subtitle}>
              {typeLabel[r.resourceType ?? 'other'] ?? r.resourceType}
              {' · '}
              {statusLabel[r.status] ?? r.status}
              {r.progressPercent ? ` · ${r.progressPercent}%` : ''}
              {collectionName_(r.collectionId) ? ` · ${collectionName_(r.collectionId)}` : ''}
              {pending(r) ? ' · Sync pending' : ''}
            </Text>
            <View style={styles.row}>
              {statuses.map((s) => (
                <Button
                  key={s}
                  secondary={r.status !== s}
                  label={statusLabel[s] ?? s}
                  disabled={saving || pending(r)}
                  onPress={() =>
                    void enqueue(
                      { op: 'resource.setStatus', id: r.id, status: s, baseVersion: r.version },
                      { ...r, status: s },
                      r,
                    )
                  }
                />
              ))}
            </View>
            <View style={styles.row}>
              {!!r.url && (
                <Button
                  secondary
                  label="Open URL"
                  disabled={saving}
                  onPress={() => {
                    void Linking.openURL(r.url!);
                    if (r.status === 'saved' || r.status === 'want_to_learn') {
                      void enqueue(
                        { op: 'resource.setStatus', id: r.id, status: 'in_progress', baseVersion: r.version },
                        { ...r, status: 'in_progress' },
                        r,
                      );
                    }
                  }}
                />
              )}
              <Button
                secondary
                label="+25%"
                disabled={saving || pending(r) || (r.progressPercent ?? 0) >= 100}
                onPress={() =>
                  void enqueue(
                    {
                      op: 'resource.setProgress',
                      id: r.id,
                      progressPercent: Math.min(100, (r.progressPercent ?? 0) + 25),
                      progressSeconds: null,
                      progressMode: 'manual',
                      baseVersion: r.version,
                    },
                    { ...r, progressPercent: Math.min(100, (r.progressPercent ?? 0) + 25) },
                    r,
                  )
                }
              />
              {collections.length > 0 && (
                <Button
                  secondary
                  label={r.collectionId ? 'Unfile' : `File → ${collections[0]!.text}`}
                  disabled={saving || pending(r)}
                  onPress={() =>
                    void enqueue(
                      {
                        op: 'resource.setCollection',
                        id: r.id,
                        collectionId: r.collectionId ? null : collections[0]!.id,
                        baseVersion: r.version,
                      },
                      { ...r, collectionId: r.collectionId ? null : collections[0]!.id },
                      r,
                    )
                  }
                />
              )}
              <Button
                secondary
                label="Delete"
                disabled={saving || pending(r)}
                onPress={() =>
                  void enqueue(
                    { op: 'resource.delete', id: r.id, baseVersion: r.version },
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
