import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { documentText, plainTextDocument, readDocument } from '@personalspace/editor-schema';
import type { RecordItem } from '@personalspace/validation';
import NoteEditor from './NoteEditor';
import { newId, type LocalStore, type NoteDraft } from './store';
import { Button, styles } from './components';
import { linkedFrom, referenceNotes } from './note-links';
import { noteAttachments } from './note-attachments';
import type { AttachmentRuntime } from './attachment-runtime';
import type { AttachmentCacheEntry } from './attachment-cache-store';

export function NoteEditorScreen({
  note,
  store,
  onClose,
  onSaved,
  records,
  pendingIds,
  onOpenNote,
  onCheckpointQueued,
  closeRequest,
  attachments,
}: {
  note: RecordItem;
  store: LocalStore;
  onClose: () => void;
  onSaved: () => Promise<void>;
  records: RecordItem[];
  pendingIds: string[];
  onOpenNote: (note: RecordItem) => void;
  onCheckpointQueued: () => Promise<void>;
  closeRequest: number;
  attachments?: AttachmentRuntime | null;
}) {
  const isTask = note.type === 'task';
  const label = isTask ? 'task description' : 'note';
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [error, setError] = useState('');
  const [fileTick, setFileTick] = useState(0);
  const [cachedFiles, setCachedFiles] = useState<AttachmentCacheEntry[]>([]);
  const [removedFiles, setRemovedFiles] = useState<string[]>([]);
  useEffect(() => attachments?.subscribe(() => setFileTick((value) => value + 1)), [attachments]);
  useEffect(() => {
    let alive = true;
    void Promise.all([store.attachmentCache.list(), store.attachmentTransfers.removedIds()])
      .then(([cache, removed]) => {
        if (alive) {
          setCachedFiles(cache);
          setRemovedFiles(removed);
        }
      })
      .catch(() => {
        if (alive) setError('Could not refresh file availability.');
      });
    return () => {
      alive = false;
    };
  }, [store, fileTick, records]);
  const currentNote = records.find((record) => record.id === note.id) ?? note;
  const conflicted = !!draft && draft.baseVersion !== currentNote.version;
  useEffect(() => {
    let alive = true;
    void store
      .loadDraft(note.id)
      .then((saved) => {
        if (!alive) return;
        setRecovered(!!saved);
        setDraft(
          saved ?? {
            content: isTask
              ? (note.descriptionJson ?? plainTextDocument(''))
              : note.contentJson
                ? readDocument(note.contentJson, note.contentSchemaVersion)
                : plainTextDocument(note.text),
            baseVersion: note.version,
          },
        );
      })
      .catch(() => {
        if (alive) setError('Could not load your content or draft. Close and try again.');
      });
    return () => {
      alive = false;
    };
  }, [note, store, isTask]);

  return (
    <SafeAreaView style={styles.root}>
      {!draft ? (
        <>
          <Text style={styles.page}>{error || `Opening your ${label}…`}</Text>
          <Button label="Close" onPress={onClose} />
        </>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <NoteEditor
            onPreviewAttachment={
              isTask
                ? undefined
                : async (id) => {
                    if (!attachments) throw new Error('Files unavailable');
                    return attachments.previewImage(id);
                  }
            }
            onAddAttachment={
              isTask
                ? undefined
                : async () => {
                    if (!attachments) return 'Files are unavailable in this app version.';
                    try {
                      await attachments.pick(note.id);
                      return null;
                    } catch (reason) {
                      return reason instanceof Error &&
                        /^(Choose a file|This file type|Sync or restore)/.test(reason.message)
                        ? reason.message
                        : 'Could not add this file. Your draft is safe; please try again.';
                    }
                  }
            }
            attachments={
              isTask ? undefined : noteAttachments(records, note.id, cachedFiles, removedFiles)
            }
            onOpenAttachment={
              isTask
                ? undefined
                : async (id) => {
                    if (!attachments) return 'Files are unavailable in this app version.';
                    try {
                      await attachments.share(id);
                      return null;
                    } catch {
                      return 'Could not open this file. It may need an internet connection or may no longer be available.';
                    }
                  }
            }
            label={isTask ? 'Task description' : 'Note'}
            initialContent={draft.content}
            recovered={recovered}
            conflicted={conflicted}
            recoveredFromId={note.recoveredFromId}
            onSaveCopy={
              !isTask && conflicted
                ? async (content) => {
                    const id = newId();
                    const now = new Date().toISOString();
                    try {
                      await store.enqueue(
                        {
                          mutationId: newId(),
                          command: {
                            op: 'note.copyDraft',
                            id,
                            sourceId: note.id,
                            sourceBaseVersion: draft.baseVersion,
                            contentJson: content,
                            contentSchemaVersion: 1,
                          },
                        },
                        {
                          ...currentNote,
                          id,
                          version: 0,
                          text: documentText(content),
                          contentJson: content,
                          contentSchemaVersion: 1,
                          recoveredFromId: note.id,
                          kind: 'note',
                          dailyDate: null,
                          pinned: false,
                          favorite: false,
                          archivedAt: null,
                          deletedAt: null,
                          tags: [],
                          createdAt: now,
                          updatedAt: now,
                        },
                      );
                      await onSaved();
                      return null;
                    } catch (error) {
                      return error instanceof Error
                        ? error.message
                        : 'Could not queue the draft copy. Your original draft is safe.';
                    }
                  }
                : undefined
            }
            closeRequest={closeRequest}
            referenceNotes={isTask ? undefined : referenceNotes(records, pendingIds)}
            linkedFrom={
              isTask ? undefined : referenceNotes(linkedFrom(records, note.id), pendingIds)
            }
            onOpenNote={async (id) => {
              const target = records.find(
                (record) => record.id === id && record.type === 'note' && !record.deletedAt,
              );
              if (!target)
                return 'This note is unavailable. It may be in Trash or not yet synced to this device.';
              if (!target.version || pendingIds.includes(id))
                return 'Wait for this note’s pending changes to sync before opening it.';
              onOpenNote(target);
              return null;
            }}
            dom={{ style: { flex: 1 }, scrollEnabled: false }}
            onDraft={async (content) => {
              await store.saveDraft(note.id, { content, baseVersion: draft.baseVersion });
            }}
            onCheckpoint={
              isTask || conflicted
                ? undefined
                : async (content, reason) => {
                    await store.enqueue({
                      mutationId: newId(),
                      command: {
                        op: 'note.checkpoint',
                        id: note.id,
                        contentJson: content,
                        contentSchemaVersion: 1,
                        baseVersion: draft.baseVersion,
                        reason,
                      },
                    });
                    await onCheckpointQueued();
                  }
            }
            onSave={async (content) => {
              if (draft.baseVersion !== currentNote.version)
                return `This ${label} changed elsewhere. Your draft is safe.${isTask ? '' : ' Use Save as separate note to preserve it.'}`;
              await store.enqueue(
                {
                  mutationId: newId(),
                  command: {
                    op: isTask ? 'task.updateDescription' : 'note.updateContent',
                    id: note.id,
                    contentJson: content,
                    contentSchemaVersion: 1,
                    baseVersion: draft.baseVersion,
                  },
                },
                {
                  ...currentNote,
                  ...(isTask
                    ? { descriptionJson: content, descriptionSchemaVersion: 1 as const }
                    : {
                        contentJson: content,
                        contentSchemaVersion: 1 as const,
                        text: documentText(content),
                      }),
                  updatedAt: new Date().toISOString(),
                },
                currentNote,
              );
              await onSaved();
              return null;
            }}
            onClose={async () => onClose()}
            onDiscard={async () => {
              Alert.alert(
                'Discard this draft?',
                isTask
                  ? 'Your saved content will stay unchanged. Unfinished edits on this device will be removed.'
                  : 'Your saved note stays unchanged. This device’s draft will be removed; any history checkpoints already queued or synced remain available.',
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
