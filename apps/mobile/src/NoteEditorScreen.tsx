import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { documentText, plainTextDocument, readDocument } from '@personalspace/editor-schema';
import type { RecordItem } from '@personalspace/validation';
import NoteEditor from './NoteEditor';
import { newId, type LocalStore, type NoteDraft } from './store';
import { Button, styles } from './components';

export function NoteEditorScreen({
  note,
  store,
  onClose,
  onSaved,
}: {
  note: RecordItem;
  store: LocalStore;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void store
      .loadDraft(note.id)
      .then((saved) => {
        if (!alive) return;
        setRecovered(!!saved);
        setDraft(
          saved ?? {
            content: note.contentJson
              ? readDocument(note.contentJson, note.contentSchemaVersion)
              : plainTextDocument(note.text),
            baseVersion: note.version,
          },
        );
      })
      .catch(() => {
        if (alive) setError('Could not load your note or draft. Close and try again.');
      });
    return () => {
      alive = false;
    };
  }, [note, store]);

  return (
    <SafeAreaView style={styles.root}>
      {!draft ? (
        <>
          <Text style={styles.page}>{error || 'Opening your note…'}</Text>
          <Button label="Close" onPress={onClose} />
        </>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <NoteEditor
            initialContent={draft.content}
            recovered={recovered}
            dom={{ style: { flex: 1 }, scrollEnabled: false }}
            onDraft={async (content) => {
              await store.saveDraft(note.id, { content, baseVersion: draft.baseVersion });
            }}
            onSave={async (content) => {
              if (draft.baseVersion !== note.version)
                return 'This note changed elsewhere. Your draft is safe. Copy anything you need, then discard the draft to open the latest note.';
              await store.enqueue(
                {
                  mutationId: newId(),
                  command: {
                    op: 'note.updateContent',
                    id: note.id,
                    contentJson: content,
                    contentSchemaVersion: 1,
                    baseVersion: draft.baseVersion,
                  },
                },
                {
                  ...note,
                  contentJson: content,
                  contentSchemaVersion: 1,
                  text: documentText(content),
                  updatedAt: new Date().toISOString(),
                },
                note,
              );
              await onSaved();
              return null;
            }}
            onClose={async () => onClose()}
            onDiscard={async () => {
              Alert.alert(
                'Discard this draft?',
                'Your saved note will stay unchanged. Unfinished edits on this device will be removed.',
                [
                  { text: 'Keep editing', style: 'cancel' },
                  {
                    text: 'Discard draft',
                    style: 'destructive',
                    onPress: () => {
                      void store
                        .discardDraft(note.id)
                        .then(onClose)
                        .catch(() => Alert.alert('Draft not discarded', 'Please try again.'));
                    },
                  },
                ],
              );
            }}
          />
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}
