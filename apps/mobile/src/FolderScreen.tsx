import { useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  commandSchema,
  folderPlacementIssue,
  recordSchema,
  type Command,
  type RecordItem,
} from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';
import { newId, type LocalStore } from './store';

export function folderPath(folder: RecordItem, folders: RecordItem[]) {
  const names = [folder.text];
  const seen = new Set([folder.id]);
  let parentId = folder.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = folders.find((f) => f.id === parentId);
    if (!parent) break;
    names.unshift(parent.text);
    parentId = parent.parentId;
  }
  return names.join(' / ');
}

export function FolderScreen({
  records,
  pendingIds,
  store,
  note,
  onClose,
  onChanged,
}: {
  records: RecordItem[];
  pendingIds: string[];
  store: LocalStore;
  note?: RecordItem | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const folders = records.filter((r) => r.type === 'folder' && !r.deletedAt);
  folders.sort((a, b) => folderPath(a, folders).localeCompare(folderPath(b, folders)));
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editing = folders.find((f) => f.id === editingId);
  const moving = folders.find((f) => f.id === movingId);
  const pending = (r: RecordItem) => r.version === 0 || pendingIds.includes(r.id);

  async function enqueue(
    command: Command,
    optimistic?: RecordItem,
    previous?: RecordItem,
    removeId?: string,
  ) {
    if (saving) return;
    const parsed = commandSchema.safeParse(command);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the folder details.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await store.enqueue(
        { mutationId: newId(), command: parsed.data },
        optimistic,
        previous,
        removeId,
      );
      setName('');
      setEditingId(null);
      setMovingId(null);
      await onChanged();
      if (note) onClose();
    } catch {
      setError('Could not save this change. Wait for pending changes to sync and try again.');
    } finally {
      setSaving(false);
    }
  }

  function chooseFolder(id: string | null) {
    if (note)
      void enqueue(
        { op: 'note.setFolder', id: note.id, folderId: id, baseVersion: note.version },
        { ...note, folderId: id },
        note,
      );
    else if (moving)
      void enqueue(
        { op: 'folder.move', id: moving.id, parentId: id, baseVersion: moving.version },
        { ...moving, parentId: id },
        moving,
      );
    else setParentId(id);
  }

  function save() {
    if (editing) {
      void enqueue(
        { op: 'folder.rename', id: editing.id, name, baseVersion: editing.version },
        { ...editing, text: name.trim() },
        editing,
      );
    } else {
      const id = newId();
      const now = new Date().toISOString();
      void enqueue(
        { op: 'folder.create', id, name, parentId },
        recordSchema.parse({
          id,
          type: 'folder',
          text: name.trim(),
          status: 'active',
          plannedDate: null,
          parentId,
          version: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }),
      );
    }
  }

  const choices = (
    <>
      <Button
        secondary
        label={note ? 'Unfiled' : 'Top level'}
        disabled={saving || (!!note && pending(note)) || (!!moving && pending(moving))}
        onPress={() => chooseFolder(null)}
      />
      {folders
        .filter((f) => f.id !== movingId)
        .map((folder) => (
          <Button
            key={folder.id}
            secondary={folder.id !== parentId}
            label={folderPath(folder, folders)}
            disabled={
              saving ||
              pending(folder) ||
              (!!note && pending(note)) ||
              (!!moving && pending(moving)) ||
              (!note &&
                folderPlacementIssue(folders, moving?.id ?? 'new-folder', folder.id) !== null)
            }
            onPress={() => chooseFolder(folder.id)}
          />
        ))}
    </>
  );

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>YOUR NOTES</Text>
        <Text style={styles.title}>
          {note ? 'Choose a folder.' : moving ? 'Move this folder.' : 'Make a little room.'}
        </Text>
        <Button secondary label="Close" disabled={saving} onPress={onClose} />
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {note || moving ? (
          <Card>
            <Text style={styles.subtitle}>
              {note
                ? 'A note belongs to one folder. Choose Unfiled to remove it from its current folder.'
                : 'Choose where this folder and its subfolders should live. Folders can be nested up to three levels.'}
            </Text>
            {choices}
            {moving && <Button secondary label="Cancel move" onPress={() => setMovingId(null)} />}
          </Card>
        ) : (
          <>
            <Card>
              <Field
                label={editing ? 'Rename folder' : 'New folder name'}
                value={name}
                onChangeText={setName}
                maxLength={100}
              />
              {!editing && (
                <>
                  <Text style={styles.label}>
                    Inside: {folders.find((f) => f.id === parentId)?.text ?? 'Top level'}
                  </Text>
                  <ScrollView horizontal contentContainerStyle={styles.row}>
                    {choices}
                  </ScrollView>
                </>
              )}
              <Button
                label={editing ? 'Save name' : 'Create folder'}
                disabled={saving || !name.trim() || (!!editing && pending(editing))}
                onPress={save}
              />
              {editing && (
                <Button
                  secondary
                  label="Cancel rename"
                  onPress={() => {
                    setEditingId(null);
                    setName('');
                  }}
                />
              )}
            </Card>
            {!folders.length && (
              <Text style={styles.subtitle}>
                No folders yet. Start with a subject, project, or part of your life.
              </Text>
            )}
            {folders.map((folder) => {
              const notesCount = records.filter(
                (r) => r.type === 'note' && r.folderId === folder.id,
              ).length;
              const children = folders.filter((f) => f.parentId === folder.id).length;
              return (
                <Card key={folder.id}>
                  <Text style={styles.label}>{folderPath(folder, folders)}</Text>
                  <Text style={styles.subtitle}>
                    {notesCount} notes · {children} subfolders
                    {pending(folder) ? ' · Sync pending' : ''}
                  </Text>
                  <View style={styles.row}>
                    <Button
                      secondary
                      label="Rename"
                      disabled={saving || pending(folder)}
                      onPress={() => {
                        setEditingId(folder.id);
                        setName(folder.text);
                      }}
                    />
                    <Button
                      secondary
                      label="Move"
                      disabled={saving || pending(folder)}
                      onPress={() => setMovingId(folder.id)}
                    />
                    <Button
                      secondary
                      label="Delete empty folder"
                      disabled={saving || pending(folder) || notesCount > 0 || children > 0}
                      onPress={() =>
                        Alert.alert(
                          'Delete this empty folder?',
                          'The folder will be removed from all your devices.',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Delete',
                              style: 'destructive',
                              onPress: () =>
                                void enqueue(
                                  {
                                    op: 'folder.delete',
                                    id: folder.id,
                                    baseVersion: folder.version,
                                  },
                                  undefined,
                                  folder,
                                  folder.id,
                                ),
                            },
                          ],
                        )
                      }
                    />
                  </View>
                </Card>
              );
            })}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
