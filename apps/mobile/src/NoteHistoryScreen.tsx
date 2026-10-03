import { useEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { createClient } from '@personalspace/api-client';
import { documentText } from '@personalspace/editor-schema';
import type { NoteVersion, RecordItem } from '@personalspace/validation';
import { Button, Card, styles } from './components';
import { NotePreview } from './NotePreview';
import { newId, type LocalStore } from './store';

export function NoteHistoryScreen({
  note,
  store,
  client,
  onClose,
  onRestored,
  records,
}: {
  note: RecordItem;
  store: LocalStore;
  client: Pick<ReturnType<typeof createClient>, 'noteHistory'>;
  onClose: () => void;
  onRestored: () => Promise<void>;
  records: RecordItem[];
}) {
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [selected, setSelected] = useState<NoteVersion | null>(null);
  const [fullText, setFullText] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const cached = await store.history(note.id);
        if (alive) setVersions(cached);
        const page = await client.noteHistory(note.id);
        await store.cacheHistory(note.id, page.versions);
        if (alive) {
          setVersions(page.versions);
          setCursor(page.nextCursor);
        }
      } catch {
        if (alive)
          setError('Could not refresh history. Previously loaded versions are available offline.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [note.id, store, client, reload]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const page = await client.noteHistory(note.id, cursor);
      await store.cacheHistory(note.id, page.versions);
      setVersions((current) => [
        ...new Map([...current, ...page.versions].map((v) => [v.id, v])).values(),
      ]);
      setCursor(page.nextCursor);
    } catch {
      setError('Could not load older versions. Connect and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function restore(snapshot: NoteVersion) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await store.enqueue(
        {
          mutationId: newId(),
          command: {
            op: 'note.restoreVersion',
            id: note.id,
            versionId: snapshot.id,
            baseVersion: note.version,
          },
        },
        {
          ...note,
          text: documentText(snapshot.contentJson),
          contentJson: snapshot.contentJson,
          contentSchemaVersion: snapshot.contentSchemaVersion,
          updatedAt: new Date().toISOString(),
        },
        note,
      );
      await onRestored();
    } catch {
      setError('Could not restore this version. Your saved note and local draft are preserved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>NOTE HISTORY</Text>
        <Text style={styles.title}>Earlier versions.</Text>
        <Text style={styles.subtitle}>
          Restoring adds a new version. Your earlier saves stay in history.
        </Text>
        <View style={styles.row}>
          <Button label="Close" secondary disabled={saving} onPress={onClose} />
          <Button
            label={loading ? 'Loading…' : 'Refresh history'}
            secondary
            disabled={loading || saving}
            onPress={() => setReload((n) => n + 1)}
          />
        </View>
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {!versions.length && !loading && (
          <Card>
            <Text style={styles.subtitle}>
              No versions loaded yet. Connect to load saved history.
            </Text>
          </Card>
        )}
        {selected && (
          <Card>
            <Text style={styles.label}>
              Preview · {new Date(selected.createdAt).toLocaleString()}
            </Text>
            {fullText ? (
              <Text selectable style={styles.subtitle}>
                {documentText(selected.contentJson)}
              </Text>
            ) : (
              <NotePreview document={selected.contentJson} records={records} />
            )}
            <Button
              label={fullText ? 'Show formatted preview' : 'Read full text'}
              secondary
              onPress={() => setFullText(!fullText)}
            />
            <Button
              label={saving ? 'Restoring…' : 'Restore this version'}
              disabled={saving || selected.version === note.version}
              onPress={() =>
                Alert.alert(
                  'Restore this version?',
                  'This replaces the saved note with the selected content and keeps its history. Any unfinished local draft is preserved.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Restore', onPress: () => void restore(selected) },
                  ],
                )
              }
            />
          </Card>
        )}
        {versions.map((version) => (
          <Card key={version.id}>
            <Text style={styles.label}>{version.title || 'Untitled note'}</Text>
            <Text style={styles.subtitle}>
              {new Date(version.createdAt).toLocaleString()}
              {version.reason === 'restore' ? ' · Restored' : ''}
              {version.reason === 'interval' ? ' · Editing checkpoint' : ''}
              {version.version === note.version ? ' · Current' : ''}
            </Text>
            <Button
              secondary
              label="Preview version"
              disabled={saving}
              onPress={() => {
                setSelected(version);
                setFullText(false);
              }}
            />
          </Card>
        ))}
        {cursor !== null && (
          <Button
            label="Load older versions"
            secondary
            disabled={loading || saving}
            onPress={() => void loadMore()}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
