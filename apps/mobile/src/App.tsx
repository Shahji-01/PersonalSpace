import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ApiError, createClient } from '@personalspace/api-client';
import { createSyncEngine } from '@personalspace/sync';
import { captureSchema, type Capture, type RecordItem } from '@personalspace/validation';
import { suggestCapture } from '@personalspace/nlp';
import { AuthScreen } from './AuthScreen';
import { apiUrl, clearSession, loadSession, type Session } from './auth';
import { newId, openStore, type LocalStore } from './store';
import { Button, Card, Field, styles } from './components';
import { colors } from '@personalspace/ui';
import { NoteEditorScreen } from './NoteEditorScreen';
import { NotePreview } from './NotePreview';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void loadSession()
      .then(setSession)
      .catch(() =>
        Alert.alert(
          'Storage unavailable',
          'Could not read your saved session. Please sign in again.',
        ),
      )
      .finally(() => setLoaded(true));
  }, []);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar style="dark" />
        {!loaded ? (
          <Text style={styles.page}>Opening your space…</Text>
        ) : session ? (
          <Space key={session.user.id} session={session} onSignOut={() => setSession(null)} />
        ) : (
          <AuthScreen onSession={setSession} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Space({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const store = useRef<LocalStore | null>(null);
  const engine = useRef<ReturnType<typeof createSyncEngine> | null>(null);
  const mounted = useRef(true);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [problems, setProblems] = useState<Awaited<ReturnType<LocalStore['problems']>>>([]);
  const [tab, setTab] = useState<'today' | 'library'>('today');
  const [library, setLibrary] = useState<'inbox' | 'note' | 'trash'>('inbox');
  const [allTasks, setAllTasks] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [editing, setEditing] = useState<RecordItem | null>(null);
  const [editingNote, setEditingNote] = useState<RecordItem | null>(null);
  const [editText, setEditText] = useState('');
  const [subtaskParent, setSubtaskParent] = useState<string | null>(null);
  const [subtaskText, setSubtaskText] = useState('');
  const [tagging, setTagging] = useState<RecordItem | null>(null);
  const [tagText, setTagText] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [type, setType] = useState<Capture['type']>('inbox');
  const [status, setStatus] = useState('Opening local storage…');
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const client = useMemo(() => createClient(apiUrl, () => session.token), [session.token]);
  async function refreshLocal() {
    if (!store.current || !mounted.current) return;
    const [items, pending, errors] = await Promise.all([
      store.current.list(),
      store.current.pending(),
      store.current.problems(),
    ]);
    if (!mounted.current) return;
    setRecords(items);
    setProblems(errors);
    setPendingIds(
      pending.map((m) => (m.command.op === 'capture' ? m.command.payload.id : m.command.id)),
    );
  }
  async function sync() {
    if (!engine.current) return;
    setSyncing(true);
    try {
      await engine.current.sync();
      if (mounted.current) setStatus('Up to date');
    } catch (error) {
      if (mounted.current)
        setStatus(
          error instanceof ApiError && error.status === 401
            ? 'Session expired. Sign in again to sync.'
            : 'Offline or unable to sync. Saved items stay on this device.',
        );
    } finally {
      if (mounted.current) {
        setSyncing(false);
        await refreshLocal();
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void openStore(session.user.id)
      .then(async (local) => {
        if (!mounted.current) {
          await local.close();
          return;
        }
        store.current = local;
        engine.current = createSyncEngine(local, client);
        await refreshLocal();
        await sync();
      })
      .catch(() => setStatus('Could not open local storage. Restart the app to try again.'));
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void sync();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void sync();
    }, 30000);
    return () => {
      mounted.current = false;
      listener.remove();
      clearInterval(
        timer,
      ); /* Keep DB handle alive for in-flight writes; account queries are scoped. */
    };
  }, [client, session.user.id]);
  // A tag filter only makes sense in the notes and tasks views; clear it when navigating away.
  useEffect(() => {
    setTagFilter(null);
  }, [tab, library, allTasks]);
  const today = localDate();
  const tomorrow = localDate(1);
  const priorityLabels = ['None', 'Low', 'Medium', 'High', 'Urgent'];
  const inboxCount = records.filter(
    (r) => r.type === 'inbox' && r.status === 'new' && !r.deletedAt,
  ).length;
  // A note, an inbox capture, or a top-level task can be trashed; subtasks move with their parent.
  const inTrash = (r: RecordItem) =>
    !!r.deletedAt &&
    (r.type === 'note' || r.type === 'inbox' || (r.type === 'task' && !r.parentId));
  const trashCount = records.filter(inTrash).length;
  const allTags = [
    ...new Set(
      records
        .filter((r) => !r.deletedAt && (r.type === 'note' || r.type === 'task'))
        .flatMap((r) => r.tags),
    ),
  ].sort();
  const tagsVisible = allTags.length > 0 && (tab === 'today' || library === 'note');
  // §10.2: a task is "today" if planned today, due today, or overdue and not done.
  const inToday = (r: RecordItem) =>
    r.plannedDate === today ||
    r.dueDate === today ||
    (!!r.dueDate && r.dueDate < today && r.status !== 'done');
  const visible = records.filter(
    (r) =>
      (!tagFilter || r.tags.includes(tagFilter)) &&
      (tab === 'today'
        ? !r.deletedAt && r.type === 'task' && !r.parentId && (allTasks || inToday(r))
        : library === 'trash'
          ? inTrash(r)
          : !r.deletedAt && r.type === library && r.status !== 'converted'),
  );
  if (tab === 'today')
    visible.sort(
      (a, b) =>
        b.priority - a.priority ||
        (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
        a.id.localeCompare(b.id),
    );
  const subtasksOf = (parentId: string) =>
    records
      .filter((r) => r.type === 'task' && r.parentId === parentId && !r.deletedAt)
      .sort((a, b) => a.id.localeCompare(b.id));
  async function save() {
    if (!store.current || saving) return;
    const result = captureSchema.safeParse({
      id: newId(),
      type,
      text,
      plannedDate: type === 'task' ? today : null,
    });
    if (!result.success) {
      Alert.alert('Check your capture', result.error.issues[0]?.message);
      return;
    }
    setSaving(true);
    const now = new Date().toISOString();
    try {
      await store.current.enqueue(
        { mutationId: newId(), command: { op: 'capture', payload: result.data } },
        {
          ...result.data,
          status: type === 'inbox' ? 'new' : type === 'task' ? 'todo' : 'active',
          dueDate: null,
          priority: 0,
          parentId: null,
          tags: [],
          version: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      );
      setCaptureOpen(false);
      setText('');
      setStatus('Saved on this device. Sync pending.');
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Not saved', 'Your text is still here. Please try again.');
    } finally {
      setSaving(false);
    }
  }
  async function act(record: RecordItem, target?: 'note' | 'task') {
    if (!store.current) return;
    try {
      if (target)
        await store.current.enqueue(
          {
            mutationId: newId(),
            command: {
              op: 'inbox.convert',
              id: record.id,
              targetId: newId(),
              targetType: target,
              baseVersion: record.version,
            },
          },
          record,
          record,
        );
      else
        await store.current.enqueue(
          {
            mutationId: newId(),
            command: {
              op: record.status === 'done' ? 'task.reopen' : 'task.complete',
              id: record.id,
              baseVersion: record.version,
            },
          },
          { ...record, status: record.status === 'done' ? 'todo' : 'done' },
          record,
        );
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Change not saved', 'Please try again.');
    }
  }
  async function reschedule(record: RecordItem, plannedDate: string | null) {
    if (!store.current || record.plannedDate === plannedDate) return;
    try {
      await store.current.enqueue(
        {
          mutationId: newId(),
          command: {
            op: 'task.reschedule',
            id: record.id,
            plannedDate,
            baseVersion: record.version,
          },
        },
        { ...record, plannedDate },
        record,
      );
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Change not saved', 'Please try again.');
    }
  }
  async function setPriority(record: RecordItem, priority: number) {
    if (!store.current || record.priority === priority) return;
    try {
      await store.current.enqueue(
        {
          mutationId: newId(),
          command: { op: 'task.setPriority', id: record.id, priority, baseVersion: record.version },
        },
        { ...record, priority },
        record,
      );
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Change not saved', 'Please try again.');
    }
  }
  async function setDueDate(record: RecordItem, dueDate: string | null) {
    if (!store.current || record.dueDate === dueDate) return;
    try {
      await store.current.enqueue(
        {
          mutationId: newId(),
          command: { op: 'task.setDueDate', id: record.id, dueDate, baseVersion: record.version },
        },
        { ...record, dueDate },
        record,
      );
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Change not saved', 'Please try again.');
    }
  }
  async function addSubtask(parent: RecordItem, subtaskText: string) {
    if (!store.current) return;
    const trimmed = subtaskText.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    const id = newId();
    try {
      await store.current.enqueue(
        {
          mutationId: newId(),
          command: { op: 'task.addSubtask', id, parentId: parent.id, text: trimmed },
        },
        {
          id,
          type: 'task',
          text: trimmed,
          status: 'todo',
          plannedDate: null,
          dueDate: null,
          priority: 0,
          parentId: parent.id,
          tags: [],
          version: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      );
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Not saved', 'The subtask could not be added. Please try again.');
    }
  }
  async function saveEdit() {
    if (!store.current || !editing || saving) return;
    const trimmed = editText.trim();
    if (!trimmed) {
      Alert.alert('Nothing to save', 'Add some text, or delete this item if you are done.');
      return;
    }
    const command =
      editing.type === 'note'
        ? ({
            op: 'note.edit',
            id: editing.id,
            text: trimmed,
            baseVersion: editing.version,
          } as const)
        : ({
            op: 'task.rename',
            id: editing.id,
            text: trimmed,
            baseVersion: editing.version,
          } as const);
    setSaving(true);
    try {
      await store.current.enqueue(
        { mutationId: newId(), command },
        { ...editing, text: trimmed, updatedAt: new Date().toISOString() },
        editing,
      );
      setEditing(null);
      setEditText('');
      setStatus('Saved on this device. Sync pending.');
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Not saved', 'Your changes are still here. Please try again.');
    } finally {
      setSaving(false);
    }
  }
  async function saveTags() {
    if (!store.current || !tagging || saving) return;
    // Match the server's normalization so the optimistic record equals the synced result.
    const parsed = [
      ...new Set(
        tagText
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      ),
    ].slice(0, 20);
    if (parsed.some((t) => t.length > 30)) {
      Alert.alert('Tag too long', 'Each tag must be 30 characters or fewer.');
      return;
    }
    setSaving(true);
    try {
      await store.current.enqueue(
        {
          mutationId: newId(),
          command: {
            op: 'item.setTags',
            id: tagging.id,
            tags: parsed,
            baseVersion: tagging.version,
          },
        },
        { ...tagging, tags: parsed, updatedAt: new Date().toISOString() },
        tagging,
      );
      setTagging(null);
      setTagText('');
      setStatus('Saved on this device. Sync pending.');
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Not saved', 'Your tags are still here. Please try again.');
    } finally {
      setSaving(false);
    }
  }
  async function trashRecord(record: RecordItem) {
    if (!store.current) return;
    const command =
      record.type === 'note'
        ? ({ op: 'note.delete', id: record.id, baseVersion: record.version } as const)
        : record.type === 'task'
          ? ({ op: 'task.delete', id: record.id, baseVersion: record.version } as const)
          : ({ op: 'inbox.delete', id: record.id, baseVersion: record.version } as const);
    try {
      await store.current.enqueue(
        { mutationId: newId(), command },
        { ...record, deletedAt: new Date().toISOString() },
        record,
      );
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Change not saved', 'Please try again.');
    }
  }
  async function restoreRecord(record: RecordItem) {
    if (!store.current) return;
    const command =
      record.type === 'note'
        ? ({ op: 'note.restore', id: record.id, baseVersion: record.version } as const)
        : record.type === 'task'
          ? ({ op: 'task.restore', id: record.id, baseVersion: record.version } as const)
          : ({ op: 'inbox.restore', id: record.id, baseVersion: record.version } as const);
    try {
      await store.current.enqueue(
        { mutationId: newId(), command },
        { ...record, deletedAt: null },
        record,
      );
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Change not saved', 'Please try again.');
    }
  }
  async function purgeRecord(record: RecordItem) {
    if (!store.current) return;
    const command =
      record.type === 'note'
        ? ({ op: 'note.purge', id: record.id, baseVersion: record.version } as const)
        : record.type === 'task'
          ? ({ op: 'task.purge', id: record.id, baseVersion: record.version } as const)
          : ({ op: 'inbox.purge', id: record.id, baseVersion: record.version } as const);
    try {
      await store.current.enqueue({ mutationId: newId(), command }, undefined, record, record.id);
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Change not saved', 'Please try again.');
    }
  }
  async function signOut() {
    if (engine.current) {
      try {
        await engine.current.sync();
      } catch {
        /* Outbox remains stored for this account. */
      }
    }
    try {
      await client.signOut();
    } catch {
      /* Local sign-out remains available offline. */
    }
    await clearSession();
    onSignOut();
  }
  return (
    <>
      <ScrollView
        contentContainerStyle={styles.page}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => void sync()} />}
      >
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text style={styles.eyebrow}>PERSONALSPACE</Text>
          <Button
            secondary
            label="Sign out"
            onPress={() =>
              Alert.alert(
                'Sign out?',
                'Unsynced items stay on this device for this account. If offline, the server session remains active until it expires.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Sign out', onPress: () => void signOut() },
                ],
              )
            }
          />
        </View>
        <Text style={styles.subtitle}>
          {new Intl.DateTimeFormat('en-IN', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          }).format(new Date())}
        </Text>
        <Text style={styles.title}>
          {tab === 'today'
            ? `Your day, ${session.user.name.split(' ')[0]}.`
            : 'Room for your ideas.'}
        </Text>
        <Text style={styles.subtitle}>
          {tab === 'today'
            ? 'One small step at a time.'
            : 'Capture first. Organize when you are ready.'}
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.subtitle}>
          {pendingIds.length ? `${pendingIds.length} waiting to sync · ` : ''}
          {status}
        </Text>
        {problems.map((problem) => (
          <Card key={problem.id}>
            <Text style={styles.error}>A change could not sync: {problem.error}</Text>
            <Button
              secondary
              label="Dismiss failed change"
              onPress={() =>
                Alert.alert(
                  'Discard failed change?',
                  'A failed new capture will be removed from this device. Other saved records remain.',
                  [
                    { text: 'Keep', style: 'cancel' },
                    {
                      text: 'Discard',
                      style: 'destructive',
                      onPress: () => {
                        void store.current?.dismissProblem(problem.id).then(refreshLocal);
                      },
                    },
                  ],
                )
              }
            />
          </Card>
        ))}
        {tab === 'today' ? (
          <View style={styles.row}>
            <Button secondary={allTasks} label="Today" onPress={() => setAllTasks(false)} />
            <Button secondary={!allTasks} label="All tasks" onPress={() => setAllTasks(true)} />
            <Button
              secondary
              label={`Inbox · ${inboxCount}`}
              onPress={() => {
                setTab('library');
                setLibrary('inbox');
              }}
            />
          </View>
        ) : (
          <View style={styles.row}>
            <Button
              secondary={library !== 'inbox'}
              label={`Inbox · ${inboxCount}`}
              onPress={() => setLibrary('inbox')}
            />
            <Button
              secondary={library !== 'note'}
              label="Notes"
              onPress={() => setLibrary('note')}
            />
            <Button
              secondary={library !== 'trash'}
              label={`Trash · ${trashCount}`}
              onPress={() => setLibrary('trash')}
            />
          </View>
        )}
        {tagsVisible && (
          <View style={styles.row}>
            <Text style={styles.label}>Tags</Text>
            {allTags.map((tag) => (
              <Button
                key={tag}
                secondary={tagFilter !== tag}
                label={`#${tag}`}
                onPress={() => setTagFilter(tagFilter === tag ? null : tag)}
              />
            ))}
          </View>
        )}
        {!visible.length && (
          <Card>
            <Text style={[styles.title, { fontSize: 24 }]}>
              {tab === 'today'
                ? 'Make room for what matters.'
                : library === 'inbox'
                  ? 'A clear inbox.'
                  : library === 'trash'
                    ? 'Trash is empty.'
                    : 'Your notes will live here.'}
            </Text>
            <Text style={styles.subtitle}>
              {tab === 'today'
                ? 'Add one thing you want to do today.'
                : library === 'trash'
                  ? 'Deleted notes and tasks wait here so you can restore them.'
                  : 'A thought, an idea, something to remember. Save it in a moment.'}
            </Text>
            {library !== 'trash' && (
              <Button label="Capture something" onPress={() => setCaptureOpen(true)} />
            )}
          </Card>
        )}
        {visible.map((record) => (
          <Card key={record.id}>
            {record.type === 'note' && record.contentJson ? (
              <NotePreview document={record.contentJson} />
            ) : (
              <Text
                style={[
                  styles.label,
                  { fontSize: 18, lineHeight: 26 },
                  record.status === 'done' && { textDecorationLine: 'line-through' },
                ]}
              >
                {record.text}
              </Text>
            )}
            <Text style={styles.subtitle}>
              {pendingIds.includes(record.id) || record.version === 0
                ? 'Saved locally · not synced'
                : record.deletedAt
                  ? 'In Trash'
                  : record.type === 'task'
                    ? record.status === 'done'
                      ? 'Completed'
                      : (record.plannedDate ?? 'No planned date')
                    : 'Saved'}
            </Text>
            {(record.type === 'note' || record.type === 'task') &&
              !record.deletedAt &&
              record.tags.length > 0 && (
                <Text style={[styles.subtitle, { color: colors.primary }]}>
                  {record.tags.map((t) => `#${t}`).join('  ')}
                </Text>
              )}
            {record.type === 'task' &&
              !record.deletedAt &&
              (record.priority > 0 || record.dueDate) && (
                <Text
                  style={[
                    styles.subtitle,
                    record.dueDate && record.dueDate < today && record.status !== 'done'
                      ? { color: colors.danger }
                      : {},
                  ]}
                >
                  {[
                    record.priority > 0 ? `${priorityLabels[record.priority]} priority` : null,
                    record.dueDate
                      ? record.dueDate < today && record.status !== 'done'
                        ? `Overdue — due ${record.dueDate}`
                        : `Due ${record.dueDate}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              )}
            {record.type === 'note' && !record.deletedAt && (
              <View style={styles.row}>
                <Button
                  secondary
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  label="Edit"
                  onPress={() => {
                    setEditingNote(record);
                  }}
                />
                <Button
                  secondary
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  label="Tags"
                  onPress={() => {
                    setTagText(record.tags.join(', '));
                    setTagging(record);
                  }}
                />
                <Button
                  secondary
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  label="Move to Trash"
                  onPress={() => void trashRecord(record)}
                />
              </View>
            )}
            {record.deletedAt && (
              <View style={styles.row}>
                <Button
                  secondary
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  label="Restore"
                  onPress={() => void restoreRecord(record)}
                />
                <Button
                  secondary
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  label="Delete forever"
                  onPress={() =>
                    Alert.alert(
                      'Delete forever?',
                      record.type === 'task'
                        ? 'This permanently removes the task and its subtasks from your account. This cannot be undone.'
                        : record.type === 'inbox'
                          ? 'This permanently removes the captured item from your account. This cannot be undone.'
                          : 'This permanently removes the note from your account. This cannot be undone.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete forever',
                          style: 'destructive',
                          onPress: () => void purgeRecord(record),
                        },
                      ],
                    )
                  }
                />
              </View>
            )}
            {record.type === 'task' &&
              !record.deletedAt &&
              (() => {
                const busy = pendingIds.includes(record.id) || record.version === 0;
                const subs = subtasksOf(record.id);
                const doneCount = subs.filter((s) => s.status === 'done').length;
                return (
                  <>
                    <Button
                      secondary
                      disabled={busy}
                      label={record.status === 'done' ? 'Reopen task' : 'Mark complete'}
                      onPress={() => void act(record)}
                    />
                    <View style={styles.row}>
                      <Button
                        secondary
                        disabled={busy}
                        label="Edit"
                        onPress={() => {
                          setEditText(record.text);
                          setEditing(record);
                        }}
                      />
                      <Button
                        secondary
                        disabled={busy}
                        label="Tags"
                        onPress={() => {
                          setTagText(record.tags.join(', '));
                          setTagging(record);
                        }}
                      />
                      <Button
                        secondary
                        disabled={busy}
                        label="Move to Trash"
                        onPress={() => void trashRecord(record)}
                      />
                    </View>
                    <View style={styles.row}>
                      <Text style={styles.label}>Plan</Text>
                      <Button
                        secondary={record.plannedDate !== today}
                        disabled={busy}
                        label="Today"
                        onPress={() => void reschedule(record, today)}
                      />
                      <Button
                        secondary={record.plannedDate !== tomorrow}
                        disabled={busy}
                        label="Tomorrow"
                        onPress={() => void reschedule(record, tomorrow)}
                      />
                      <Button
                        secondary={record.plannedDate !== null}
                        disabled={busy}
                        label="No date"
                        onPress={() => void reschedule(record, null)}
                      />
                    </View>
                    <View style={styles.row}>
                      <Text style={styles.label}>Deadline</Text>
                      <Button
                        secondary={record.dueDate !== today}
                        disabled={busy}
                        label="Today"
                        onPress={() => void setDueDate(record, today)}
                      />
                      <Button
                        secondary={record.dueDate !== tomorrow}
                        disabled={busy}
                        label="Tomorrow"
                        onPress={() => void setDueDate(record, tomorrow)}
                      />
                      <Button
                        secondary={record.dueDate !== null}
                        disabled={busy}
                        label="None"
                        onPress={() => void setDueDate(record, null)}
                      />
                    </View>
                    <View style={styles.row}>
                      <Text style={styles.label}>Priority</Text>
                      {priorityLabels.map((plabel, level) => (
                        <Button
                          key={plabel}
                          secondary={record.priority !== level}
                          disabled={busy}
                          label={plabel}
                          onPress={() => void setPriority(record, level)}
                        />
                      ))}
                    </View>
                    {subs.length > 0 && (
                      <Text
                        style={styles.subtitle}
                      >{`Subtasks · ${doneCount}/${subs.length} done`}</Text>
                    )}
                    {subs.map((sub) => (
                      <View key={sub.id} style={styles.row}>
                        <Button
                          secondary
                          disabled={pendingIds.includes(sub.id) || sub.version === 0}
                          label={sub.status === 'done' ? '✓ Done' : 'Mark done'}
                          onPress={() => void act(sub)}
                        />
                        <Text
                          style={[
                            styles.label,
                            { flex: 1, fontWeight: '400' },
                            sub.status === 'done' && { textDecorationLine: 'line-through' },
                          ]}
                        >
                          {sub.text}
                        </Text>
                      </View>
                    ))}
                    {subtaskParent === record.id ? (
                      <View style={{ gap: 8 }}>
                        <Field
                          label="New subtask"
                          autoFocus
                          value={subtaskText}
                          onChangeText={setSubtaskText}
                          maxLength={500}
                        />
                        <View style={styles.row}>
                          <Button
                            label="Add"
                            disabled={!subtaskText.trim()}
                            onPress={() => {
                              void addSubtask(record, subtaskText);
                              setSubtaskText('');
                              setSubtaskParent(null);
                            }}
                          />
                          <Button
                            secondary
                            label="Cancel"
                            onPress={() => {
                              setSubtaskText('');
                              setSubtaskParent(null);
                            }}
                          />
                        </View>
                      </View>
                    ) : (
                      <Button
                        secondary
                        disabled={busy}
                        label="Add subtask"
                        onPress={() => {
                          setSubtaskText('');
                          setSubtaskParent(record.id);
                        }}
                      />
                    )}
                  </>
                );
              })()}
            {record.type === 'inbox' && !record.deletedAt && (
              <View style={styles.row}>
                <Button
                  secondary
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  label="Make a note"
                  onPress={() => void act(record, 'note')}
                />
                <Button
                  secondary
                  disabled={
                    pendingIds.includes(record.id) ||
                    record.version === 0 ||
                    record.text.length > 500
                  }
                  label="Make a task"
                  onPress={() => void act(record, 'task')}
                />
                <Button
                  secondary
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  label="Dismiss"
                  onPress={() => void trashRecord(record)}
                />
              </View>
            )}
          </Card>
        ))}
      </ScrollView>
      <View style={styles.nav}>
        <View style={{ flex: 1 }}>
          <Button secondary={tab !== 'today'} label="Today" onPress={() => setTab('today')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button secondary={tab !== 'library'} label="Library" onPress={() => setTab('library')} />
        </View>
        <Button label="＋ Capture" disabled={!store.current} onPress={() => setCaptureOpen(true)} />
      </View>
      <Modal
        visible={captureOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          if (!saving) setCaptureOpen(false);
        }}
      >
        <SafeAreaView style={styles.root}>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
              <Text style={styles.eyebrow}>QUICK CAPTURE</Text>
              <Text style={styles.title}>What’s on your mind?</Text>
              <Field
                label="Your thought"
                autoFocus
                multiline
                value={text}
                onChangeText={setText}
                maxLength={20000}
              />
              <Text style={styles.subtitle}>{suggestCapture(text).reason}</Text>
              <View style={styles.row}>
                {(['inbox', 'note', 'task'] as const).map((option) => (
                  <Button
                    key={option}
                    label={
                      option === 'inbox' ? 'Inbox' : option === 'note' ? 'Note' : 'Task for today'
                    }
                    secondary={type !== option}
                    onPress={() => setType(option)}
                  />
                ))}
              </View>
              <Button
                label={saving ? 'Saving…' : 'Save'}
                disabled={!text.trim() || saving}
                onPress={() => void save()}
              />
              <Button
                secondary
                label="Close"
                disabled={saving}
                onPress={() => setCaptureOpen(false)}
              />
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
      <Modal
        visible={editingNote !== null}
        animationType="slide"
        onRequestClose={() => setEditingNote(null)}
      >
        {editingNote && store.current && (
          <NoteEditorScreen
            key={editingNote.id}
            note={editingNote}
            store={store.current}
            onClose={() => setEditingNote(null)}
            onSaved={async () => {
              setEditingNote(null);
              setStatus('Saved on this device. Sync pending.');
              await refreshLocal();
              void sync();
            }}
          />
        )}
      </Modal>
      <Modal
        visible={editing !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          if (!saving) setEditing(null);
        }}
      >
        <SafeAreaView style={styles.root}>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
              <Text style={styles.eyebrow}>
                {editing?.type === 'task' ? 'RENAME TASK' : 'EDIT NOTE'}
              </Text>
              <Text style={styles.title}>Make it yours.</Text>
              <Field
                label={editing?.type === 'task' ? 'Task name' : 'Your note'}
                autoFocus
                multiline={editing?.type !== 'task'}
                value={editText}
                onChangeText={setEditText}
                maxLength={editing?.type === 'task' ? 500 : 20000}
              />
              <Button
                label={saving ? 'Saving…' : 'Save changes'}
                disabled={!editText.trim() || saving}
                onPress={() => void saveEdit()}
              />
              <Button secondary label="Cancel" disabled={saving} onPress={() => setEditing(null)} />
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
      <Modal
        visible={tagging !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          if (!saving) setTagging(null);
        }}
      >
        <SafeAreaView style={styles.root}>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
              <Text style={styles.eyebrow}>TAGS</Text>
              <Text style={styles.title}>Find it later.</Text>
              <Field
                label="Comma-separated tags"
                autoFocus
                value={tagText}
                onChangeText={setTagText}
                placeholder="work, urgent"
                autoCapitalize="none"
                maxLength={640}
              />
              <Text style={styles.subtitle}>
                Up to 20 tags, 30 characters each. Tags are saved in lowercase.
              </Text>
              <Button
                label={saving ? 'Saving…' : 'Save tags'}
                disabled={saving}
                onPress={() => void saveTags()}
              />
              <Button secondary label="Cancel" disabled={saving} onPress={() => setTagging(null)} />
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
function localDate(offsetDays = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
