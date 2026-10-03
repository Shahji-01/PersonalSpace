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
import { createSyncEngine, createSyncScheduler } from '@personalspace/sync';
import {
  captureSchema,
  recordSchema,
  deadlineLabel,
  deadlineLocalDate,
  currentTimeZone,
  type Mutation,
  type Capture,
  type RecordItem,
} from '@personalspace/validation';
import { suggestCapture } from '@personalspace/nlp';
import { AuthScreen } from './AuthScreen';
import { apiUrl, clearSession, loadSession, type Session } from './auth';
import { newId, openStore, type LocalStore } from './store';
import { Button, Card, Field, styles } from './components';
import { colors } from '@personalspace/ui';
import { NoteEditorScreen } from './NoteEditorScreen';
import { TaskDetailsScreen } from './TaskDetailsScreen';
import { SearchScreen } from './SearchScreen';
import { NotePreview } from './NotePreview';
import { NoteHistoryScreen } from './NoteHistoryScreen';
import { FolderScreen, folderPath } from './FolderScreen';
import { ProjectScreen } from './ProjectScreen';
import { ProjectNotesScreen } from './ProjectNotesScreen';
import { taskIsClosed, taskIsOverdue, taskMatches, taskViews, type TaskView } from './task-views';

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
  const scheduler = useRef<ReturnType<typeof createSyncScheduler> | null>(null);
  const mounted = useRef(true);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [problems, setProblems] = useState<Awaited<ReturnType<LocalStore['problems']>>>([]);
  const [tab, setTab] = useState<'today' | 'library'>('today');
  const [library, setLibrary] = useState<'inbox' | 'note' | 'trash' | 'archived'>('inbox');
  const [taskView, setTaskView] = useState<TaskView>('today');
  const [captureOpen, setCaptureOpen] = useState(false);
  const [editing, setEditing] = useState<RecordItem | null>(null);
  const [editingNote, setEditingNote] = useState<RecordItem | null>(null);
  const [noteCloseRequest, setNoteCloseRequest] = useState(0);
  const [taskDetails, setTaskDetails] = useState<RecordItem | null>(null);
  const [openingDaily, setOpeningDaily] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyNote, setHistoryNote] = useState<RecordItem | null>(null);
  const [folderScreen, setFolderScreen] = useState(false);
  const [filingNote, setFilingNote] = useState<RecordItem | null>(null);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [projectScreen, setProjectScreen] = useState(false);
  const [projectNotes, setProjectNotes] = useState<RecordItem | null>(null);
  const [assigningTask, setAssigningTask] = useState<RecordItem | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [subtaskParent, setSubtaskParent] = useState<string | null>(null);
  const [subtaskText, setSubtaskText] = useState('');
  const [tagging, setTagging] = useState<RecordItem | null>(null);
  const [tagText, setTagText] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [type, setType] = useState<Capture['type']>('inbox');
  const [captureDate, setCaptureDate] = useState<string | null>(null);
  const [captureDeadline, setCaptureDeadline] = useState('');
  const [captureDeadlineOpen, setCaptureDeadlineOpen] = useState(false);
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
    setPendingCount(pending.length);
    setPendingIds(
      pending
        .filter((m) => m.command.op !== 'note.checkpoint')
        .map((m) => (m.command.op === 'capture' ? m.command.payload.id : m.command.id)),
    );
  }
  async function sync(manual = false) {
    await scheduler.current?.request(manual);
  }
  useEffect(() => {
    mounted.current = true;
    void openStore(
      session.user.id,
      (record) =>
        new Promise((resolve) =>
          Alert.alert(
            'Change repeating task',
            `How should this change apply to “${record.text}”?`,
            [
              { text: 'This occurrence', onPress: () => resolve('occurrence') },
              { text: 'This and future', onPress: () => resolve('future') },
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
            ],
            { cancelable: true, onDismiss: () => resolve(null) },
          ),
        ),
    )
      .then(async (local) => {
        if (!mounted.current) {
          await local.close();
          return;
        }
        store.current = local;
        engine.current = createSyncEngine(local, client);
        const localEngine = engine.current;
        scheduler.current = createSyncScheduler({
          sync: async () => {
            try {
              await localEngine.sync();
            } finally {
              await refreshLocal();
            }
          },
          retry: (error) => ({
            pause: error instanceof ApiError && (error.status === 401 || error.status === 403),
            afterMs: error instanceof ApiError ? error.retryAfterMs : undefined,
          }),
          onState: (state) => {
            if (!mounted.current) return;
            setSyncing(state.status === 'syncing');
            if (state.status === 'synced') setStatus('Up to date');
            else if (state.status === 'paused')
              setStatus(
                'Sync paused. Sign in again or pull to retry. Saved items stay on this device.',
              );
            else if (state.status === 'retrying')
              setStatus(
                `Unable to sync. Retrying at ${new Date(state.retryAt).toLocaleTimeString()}. Items are saved on this device.`,
              );
          },
        });
        scheduler.current.setActive(AppState.currentState === 'active');
        await refreshLocal();
        await sync();
      })
      .catch(() => setStatus('Could not open local storage. Restart the app to try again.'));
    const listener = AppState.addEventListener('change', (state) => {
      scheduler.current?.setActive(state === 'active');
    });
    return () => {
      mounted.current = false;
      listener.remove();
      scheduler.current?.dispose();
      /* Keep DB handle alive for in-flight writes; account queries are scoped. */
    };
  }, [client, session.user.id]);
  // A tag filter only makes sense in the notes and tasks views; clear it when navigating away.
  useEffect(() => {
    setTagFilter(null);
  }, [tab, library, taskView]);
  const today = localDate();
  const suggestion = suggestCapture(text, today);
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
  const archivedCount = records.filter(
    (r) => r.type === 'note' && !r.deletedAt && r.archivedAt,
  ).length;
  const allTags = [
    ...new Set(
      records
        .filter((r) => !r.deletedAt && (r.type === 'note' || r.type === 'task'))
        .flatMap((r) => r.tags),
    ),
  ].sort();
  const tagsVisible = allTags.length > 0 && (tab === 'today' || library === 'note');
  const folders = records.filter((r) => r.type === 'folder' && !r.deletedAt);
  const projects = records
    .filter((r) => r.type === 'project' && !r.deletedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  // §10.2: a task is "today" if planned today, due today, or overdue and not done.
  const closed = taskIsClosed;
  const visible = records.filter(
    (r) =>
      (!tagFilter || r.tags.includes(tagFilter)) &&
      (tab === 'today'
        ? taskMatches(r, taskView, today) &&
          (projectFilter === null ||
            (projectFilter === 'unassigned' ? !r.projectId : r.projectId === projectFilter))
        : library === 'trash'
          ? inTrash(r)
          : library === 'archived'
            ? r.type === 'note' && !r.deletedAt && !!r.archivedAt
            : library === 'note'
              ? r.type === 'note' &&
                !r.deletedAt &&
                !r.archivedAt &&
                (folderFilter === null ||
                  (folderFilter === 'unfiled' ? !r.folderId : r.folderId === folderFilter))
              : !r.deletedAt && r.type === library && r.status !== 'converted'),
  );
  // Pinned notes rise to the top of the Notes list, then favorites.
  if (tab === 'library' && library === 'note')
    visible.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.favorite) - Number(a.favorite) ||
        b.id.localeCompare(a.id),
    );
  if (tab === 'today')
    visible.sort(
      (a, b) =>
        b.priority - a.priority ||
        (deadlineLocalDate(a) ?? '9999').localeCompare(deadlineLocalDate(b) ?? '9999') ||
        a.id.localeCompare(b.id),
    );
  const subtasksOf = (parentId: string) =>
    records
      .filter((r) => r.type === 'task' && r.parentId === parentId && !r.deletedAt && !r.archivedAt)
      .sort((a, b) => a.id.localeCompare(b.id));
  async function save() {
    if (!store.current || saving) return;
    const result = captureSchema.safeParse({
      id: newId(),
      type,
      text,
      plannedDate: type === 'task' ? (captureDate ?? today) || null : null,
      ...(type === 'task' && captureDeadline ? { dueDate: captureDeadline } : {}),
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
          dueDate: result.data.dueDate ?? null,
          dueTime: null,
          timeMode: 'floating',
          timezone: null,
          dueAt: null,
          priority: 0,
          parentId: null,
          folderId: null,
          projectId: null,
          relatedNoteIds: [],
          recurrence: null,
          color: null,
          sortOrder: 0,
          completedAt: null,
          kind: 'note',
          dailyDate: null,
          recoveredFromId: null,
          descriptionJson: null,
          descriptionSchemaVersion: 1,
          estimatedMinutes: null,
          pinned: false,
          favorite: false,
          archivedAt: null,
          tags: [],
          version: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      );
      setCaptureOpen(false);
      setText('');
      setCaptureDate(null);
      setCaptureDeadline('');
      setCaptureDeadlineOpen(false);
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
              ...(record.status !== 'done'
                ? { currentTimezone: currentTimeZone(), occurredAt: new Date().toISOString() }
                : {}),
            },
          },
          {
            ...record,
            status: record.status === 'done' ? 'todo' : 'done',
            completedAt: record.status === 'done' ? null : new Date().toISOString(),
          },
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
  async function setTaskStatus(record: RecordItem, status: RecordItem['status']) {
    if (!store.current || record.status === status) return;
    try {
      await store.current.enqueue(
        {
          mutationId: newId(),
          command: {
            op: 'task.setStatus',
            currentTimezone: currentTimeZone(),
            occurredAt: new Date().toISOString(),
            id: record.id,
            status: status as 'todo' | 'in_progress' | 'done' | 'cancelled',
            baseVersion: record.version,
          },
        },
        { ...record, status, completedAt: status === 'done' ? new Date().toISOString() : null },
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
        { ...record, dueDate, dueTime: null, timeMode: 'floating', timezone: null, dueAt: null },
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
          dueTime: null,
          timeMode: 'floating',
          timezone: null,
          dueAt: null,
          priority: 0,
          parentId: parent.id,
          folderId: null,
          projectId: parent.projectId,
          relatedNoteIds: [],
          recurrence: null,
          color: null,
          sortOrder: 0,
          completedAt: null,
          kind: 'note',
          dailyDate: null,
          recoveredFromId: null,
          descriptionJson: null,
          descriptionSchemaVersion: 1,
          estimatedMinutes: null,
          pinned: false,
          favorite: false,
          archivedAt: null,
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
  async function setPinned(record: RecordItem, pinned: boolean) {
    if (!store.current) return;
    try {
      await store.current.enqueue(
        {
          mutationId: newId(),
          command: { op: 'note.setPinned', id: record.id, pinned, baseVersion: record.version },
        },
        { ...record, pinned },
        record,
      );
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Change not saved', 'Please try again.');
    }
  }
  async function setFavorite(record: RecordItem, favorite: boolean) {
    if (!store.current) return;
    try {
      await store.current.enqueue(
        {
          mutationId: newId(),
          command: { op: 'note.setFavorite', id: record.id, favorite, baseVersion: record.version },
        },
        { ...record, favorite },
        record,
      );
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Change not saved', 'Please try again.');
    }
  }
  async function setArchived(record: RecordItem, archived: boolean) {
    if (!store.current) return;
    try {
      await store.current.enqueue(
        {
          mutationId: newId(),
          command: {
            op: record.type === 'task' ? 'task.setArchived' : 'note.setArchived',
            id: record.id,
            archived,
            baseVersion: record.version,
          },
        },
        { ...record, archivedAt: archived ? new Date().toISOString() : null },
        record,
      );
      await refreshLocal();
      void sync();
    } catch {
      Alert.alert('Change not saved', 'Please try again.');
    }
  }
  async function openDailyNote() {
    if (!store.current || openingDaily) return;
    setOpeningDaily(true);
    try {
      const date = localDate();
      const findDaily = (items: RecordItem[]) =>
        items.find(
          (r) => r.type === 'note' && r.kind === 'daily' && r.dailyDate === date && !r.deletedAt,
        );
      let daily = findDaily(await store.current.list());
      if (!daily) {
        const now = new Date().toISOString();
        const id = newId();
        await store.current.enqueue(
          { mutationId: newId(), command: { op: 'note.openDaily', id, date } },
          recordSchema.parse({
            id,
            type: 'note',
            kind: 'daily',
            dailyDate: date,
            text: date,
            status: 'active',
            plannedDate: null,
            version: 0,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          }),
        );
      }
      await refreshLocal();
      if (!daily || daily.version === 0) {
        await sync();
        daily = findDaily(await store.current.list());
      }
      const pending = await store.current.pending();
      if (
        daily &&
        daily.version > 0 &&
        !pending.some(
          (m) =>
            m.command.op !== 'capture' &&
            m.command.op !== 'note.checkpoint' &&
            m.command.id === daily.id,
        )
      )
        setEditingNote(daily);
      else
        Alert.alert(
          'Daily note saved locally',
          'It will open for editing after syncing. Tap Daily note again once you are connected.',
        );
    } catch {
      Alert.alert('Could not open the daily note', 'Please try again.');
    } finally {
      setOpeningDaily(false);
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
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => void sync(true)} />}
      >
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text style={styles.eyebrow}>PERSONALSPACE</Text>
          <Button
            secondary
            label="Search"
            disabled={!store.current}
            onPress={() => setSearchOpen(true)}
          />
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
          {pendingCount ? `${pendingCount} waiting to sync · ` : ''}
          {status}
        </Text>
        {problems.map((problem) => (
          <Card key={problem.id}>
            <Text style={styles.error}>A change could not sync: {problem.error}</Text>
            {(() => {
              const command = (JSON.parse(problem.mutation) as Mutation).command;
              if (command.op !== 'note.updateContent' && command.op !== 'note.checkpoint')
                return null;
              const note = records.find(
                (r) => r.id === command.id && !r.deletedAt && r.type === 'note',
              );
              return note ? (
                <Button
                  label="Review draft"
                  disabled={pendingIds.includes(note.id)}
                  onPress={() => setEditingNote(note)}
                />
              ) : null;
            })()}
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
        {tab === 'today' && (
          <Button
            secondary
            label={openingDaily ? 'Opening daily note…' : 'Daily note'}
            disabled={openingDaily || !store.current}
            onPress={() => void openDailyNote()}
          />
        )}
        {tab === 'today' ? (
          <View style={styles.row}>
            <ScrollView horizontal contentContainerStyle={styles.row}>
              {taskViews.map((view) => (
                <Button
                  key={view.value}
                  secondary={taskView !== view.value}
                  label={view.label}
                  onPress={() => setTaskView(view.value)}
                />
              ))}
            </ScrollView>
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
              secondary={library !== 'archived'}
              label={`Archived · ${archivedCount}`}
              onPress={() => setLibrary('archived')}
            />
            <Button
              secondary={library !== 'trash'}
              label={`Trash · ${trashCount}`}
              onPress={() => setLibrary('trash')}
            />
          </View>
        )}
        {tab === 'today' && (
          <View style={{ gap: 12 }}>
            <Button
              secondary
              label="Manage projects"
              onPress={() => {
                setAssigningTask(null);
                setProjectScreen(true);
              }}
            />
            {!!projects.length && (
              <ScrollView horizontal contentContainerStyle={styles.row}>
                <Button
                  secondary={projectFilter !== null}
                  label="All projects"
                  onPress={() => setProjectFilter(null)}
                />
                <Button
                  secondary={projectFilter !== 'unassigned'}
                  label="No project"
                  onPress={() => setProjectFilter('unassigned')}
                />
                {projects
                  .filter((p) => p.status === 'active' || p.id === projectFilter)
                  .map((p) => (
                    <Button
                      key={p.id}
                      secondary={projectFilter !== p.id}
                      label={p.text}
                      onPress={() => setProjectFilter(p.id)}
                    />
                  ))}
              </ScrollView>
            )}
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
        {tab === 'library' && library === 'note' && (
          <View style={{ gap: 12 }}>
            <Button
              secondary
              label="Manage folders"
              onPress={() => {
                setFilingNote(null);
                setFolderScreen(true);
              }}
            />
            <ScrollView horizontal contentContainerStyle={styles.row}>
              <Button
                secondary={folderFilter !== null}
                label="All notes"
                onPress={() => setFolderFilter(null)}
              />
              <Button
                secondary={folderFilter !== 'unfiled'}
                label="Unfiled"
                onPress={() => setFolderFilter('unfiled')}
              />
              {folders.map((folder) => (
                <Button
                  key={folder.id}
                  secondary={folderFilter !== folder.id}
                  label={folderPath(folder, folders)}
                  onPress={() => setFolderFilter(folder.id)}
                />
              ))}
            </ScrollView>
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
                    : library === 'archived'
                      ? 'Nothing archived.'
                      : 'Your notes will live here.'}
            </Text>
            <Text style={styles.subtitle}>
              {tab === 'today'
                ? 'Add one thing you want to do today.'
                : library === 'trash'
                  ? 'Deleted notes and tasks wait here so you can restore them.'
                  : library === 'archived'
                    ? 'Archived notes are tucked away here, out of your main list.'
                    : 'A thought, an idea, something to remember. Save it in a moment.'}
            </Text>
            {library !== 'trash' && library !== 'archived' && (
              <Button label="Capture something" onPress={() => setCaptureOpen(true)} />
            )}
          </Card>
        )}
        {visible.map((record) => (
          <Card key={record.id}>
            {record.type === 'note' && record.contentJson ? (
              <NotePreview document={record.contentJson} records={records} />
            ) : (
              <Text
                style={[
                  styles.label,
                  { fontSize: 18, lineHeight: 26 },
                  closed(record) && { textDecorationLine: 'line-through' },
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
                      : record.status === 'cancelled'
                        ? 'Cancelled'
                        : record.status === 'in_progress'
                          ? 'In progress'
                          : (record.plannedDate ?? 'No planned date')
                    : record.recoveredFromId
                      ? 'Recovered draft copy'
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
                    taskIsOverdue(record, today) ? { color: colors.danger } : {},
                  ]}
                >
                  {[
                    record.priority > 0 ? `${priorityLabels[record.priority]} priority` : null,
                    record.dueDate
                      ? taskIsOverdue(record, today)
                        ? `Overdue — due ${deadlineLabel(record)}`
                        : `Due ${deadlineLabel(record)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              )}
            {record.type === 'task' && !record.deletedAt && (
              <View style={styles.row}>
                <Button
                  secondary
                  label="Details"
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  onPress={() => setTaskDetails(record)}
                />
                <Button
                  secondary
                  label={record.archivedAt ? 'Unarchive' : 'Archive'}
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  onPress={() => void setArchived(record, !record.archivedAt)}
                />
                {!!record.estimatedMinutes && (
                  <Text style={styles.subtitle}>{record.estimatedMinutes} min estimated</Text>
                )}
                <Button
                  secondary
                  label={projects.find((p) => p.id === record.projectId)?.text ?? 'Add to project'}
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  onPress={() => {
                    setAssigningTask(record);
                    setProjectScreen(true);
                  }}
                />
              </View>
            )}
            {record.type === 'note' && !record.deletedAt && !record.archivedAt && (
              <>
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
                <View style={styles.row}>
                  <Button
                    secondary={!record.pinned}
                    disabled={pendingIds.includes(record.id) || record.version === 0}
                    label={record.pinned ? '📌 Pinned' : 'Pin'}
                    onPress={() => void setPinned(record, !record.pinned)}
                  />
                  <Button
                    secondary={!record.favorite}
                    disabled={pendingIds.includes(record.id) || record.version === 0}
                    label={record.favorite ? '★ Favorite' : 'Favorite'}
                    onPress={() => void setFavorite(record, !record.favorite)}
                  />
                  <Button
                    secondary
                    disabled={pendingIds.includes(record.id) || record.version === 0}
                    label="Archive"
                    onPress={() => void setArchived(record, true)}
                  />
                </View>
              </>
            )}
            {record.type === 'note' && !record.deletedAt && record.archivedAt && (
              <View style={styles.row}>
                <Button
                  secondary
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  label="Unarchive"
                  onPress={() => void setArchived(record, false)}
                />
                <Button
                  secondary
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  label="Move to Trash"
                  onPress={() => void trashRecord(record)}
                />
              </View>
            )}
            {record.type === 'note' && !record.deletedAt && (
              <View style={styles.row}>
                <Button
                  secondary
                  label="Folder"
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  onPress={() => {
                    setFilingNote(record);
                    setFolderScreen(true);
                  }}
                />
                <Button
                  secondary
                  label="Version history"
                  disabled={pendingIds.includes(record.id) || record.version === 0}
                  onPress={() => setHistoryNote(record)}
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
                    {record.recurrence && (
                      <Text style={styles.subtitle}>
                        Repeats · occurrence {record.recurrence.occurrenceNumber}
                        {pendingIds.includes(record.id) &&
                        ['done', 'cancelled'].includes(record.status) &&
                        !record.recurrence.advanced
                          ? ' · Next occurrence appears after sync'
                          : ''}
                      </Text>
                    )}
                    <View style={styles.row}>
                      <Text style={styles.label}>Status</Text>
                      {(['todo', 'in_progress', 'done', 'cancelled'] as const).map((s) => (
                        <Button
                          key={s}
                          secondary={record.status !== s}
                          disabled={busy}
                          label={
                            s === 'todo'
                              ? 'To do'
                              : s === 'in_progress'
                                ? 'In progress'
                                : s === 'done'
                                  ? 'Done'
                                  : record.recurrence
                                    ? 'Skip occurrence'
                                    : 'Cancelled'
                          }
                          onPress={() => void setTaskStatus(record, s)}
                        />
                      ))}
                    </View>
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
                        secondary
                        label="Edit deadline"
                        disabled={busy}
                        onPress={() => setTaskDetails(record)}
                      />
                      <Button
                        secondary={record.dueDate !== today}
                        disabled={busy || !!record.dueTime}
                        label="Today"
                        onPress={() => void setDueDate(record, today)}
                      />
                      <Button
                        secondary={record.dueDate !== tomorrow}
                        disabled={busy || !!record.dueTime}
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
              <Text style={styles.subtitle}>{suggestion.reason}</Text>
              {suggestion.type === 'task' && (
                <Button
                  secondary
                  label="Use task suggestion"
                  disabled={saving}
                  onPress={() => {
                    setType('task');
                    setCaptureDate(
                      suggestion.dates?.plannedDate ?? (suggestion.dates?.dueDate ? '' : today),
                    );
                    setCaptureDeadline(suggestion.dates?.dueDate ?? '');
                    setCaptureDeadlineOpen(!!suggestion.dates?.dueDate);
                  }}
                />
              )}
              <View style={styles.row}>
                {(['inbox', 'note', 'task'] as const).map((option) => (
                  <Button
                    key={option}
                    label={option === 'inbox' ? 'Inbox' : option === 'note' ? 'Note' : 'Task'}
                    secondary={type !== option}
                    onPress={() => setType(option)}
                  />
                ))}
              </View>
              {type === 'task' && (
                <>
                  <Field
                    label="Date"
                    value={captureDate ?? today}
                    onChangeText={setCaptureDate}
                    placeholder="YYYY-MM-DD (optional)"
                    maxLength={10}
                    editable={!saving}
                  />
                  <View style={styles.row}>
                    <Button
                      secondary
                      label="Today"
                      onPress={() => setCaptureDate(today)}
                      disabled={saving}
                    />
                    <Button
                      secondary
                      label="No date"
                      onPress={() => setCaptureDate('')}
                      disabled={saving}
                    />
                    <Button
                      secondary
                      label={captureDeadlineOpen ? 'Remove deadline' : 'Add deadline'}
                      disabled={saving}
                      onPress={() => {
                        setCaptureDeadlineOpen(!captureDeadlineOpen);
                        setCaptureDeadline('');
                      }}
                    />
                  </View>
                  {captureDeadlineOpen && (
                    <Field
                      label="Deadline"
                      value={captureDeadline}
                      onChangeText={setCaptureDeadline}
                      placeholder="YYYY-MM-DD"
                      maxLength={10}
                      editable={!saving}
                    />
                  )}
                  <Text style={styles.subtitle}>
                    Date is when you plan to do it. Deadline is when it must be finished. Your
                    original text is kept.
                  </Text>
                </>
              )}
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
        visible={taskDetails !== null}
        animationType="slide"
        onRequestClose={() => setTaskDetails(null)}
      >
        {taskDetails && store.current && (
          <TaskDetailsScreen
            key={taskDetails.id}
            task={taskDetails}
            store={store.current}
            onClose={() => setTaskDetails(null)}
            onEditDescription={() => {
              setEditingNote(taskDetails);
              setTaskDetails(null);
            }}
            onSaved={async () => {
              setTaskDetails(null);
              await refreshLocal();
              void sync();
            }}
          />
        )}
      </Modal>
      <Modal visible={searchOpen} animationType="slide" onRequestClose={() => setSearchOpen(false)}>
        {store.current && (
          <SearchScreen
            store={store.current}
            client={client}
            records={records}
            onClose={() => {
              setSearchOpen(false);
              void refreshLocal();
            }}
            onOpen={async (record) => {
              await refreshLocal();
              setSearchOpen(false);
              if (record.type === 'note') setEditingNote(record);
              else if (record.type === 'task') setTaskDetails(record);
              else if (record.type === 'project') {
                setProjectFilter(record.id);
                setTaskView('all');
                setTab('today');
              } else {
                setLibrary('inbox');
                setTab('library');
              }
            }}
          />
        )}
      </Modal>
      <Modal
        visible={editingNote !== null}
        animationType="slide"
        onRequestClose={() => setNoteCloseRequest((value) => value + 1)}
      >
        {editingNote && store.current && (
          <NoteEditorScreen
            key={editingNote.id}
            note={editingNote}
            closeRequest={noteCloseRequest}
            store={store.current}
            records={records}
            pendingIds={pendingIds}
            onOpenNote={setEditingNote}
            onCheckpointQueued={async () => {
              await refreshLocal();
              void sync();
            }}
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
        visible={projectScreen}
        animationType="slide"
        onRequestClose={() => setProjectScreen(false)}
      >
        {projectScreen && store.current && (
          <ProjectScreen
            records={records}
            pendingIds={pendingIds}
            store={store.current}
            task={assigningTask}
            onClose={() => setProjectScreen(false)}
            onChanged={async () => {
              await refreshLocal();
              void sync();
            }}
            onViewTasks={(id) => {
              setProjectFilter(id);
              setTaskView('all');
              setTab('today');
              setProjectScreen(false);
            }}
            onViewNotes={(project) => {
              setProjectScreen(false);
              setProjectNotes(project);
            }}
          />
        )}
      </Modal>
      <Modal
        visible={projectNotes !== null}
        animationType="slide"
        onRequestClose={() => setProjectNotes(null)}
      >
        {projectNotes && store.current && (
          <ProjectNotesScreen
            key={projectNotes.id}
            project={projectNotes}
            records={records}
            pendingIds={pendingIds}
            store={store.current}
            onClose={() => setProjectNotes(null)}
            onSaved={async () => {
              setProjectNotes(null);
              setStatus('Project notes saved on this device. Sync pending.');
              await refreshLocal();
              void sync();
            }}
            onOpenNote={(note) => {
              setProjectNotes(null);
              setEditingNote(note);
            }}
          />
        )}
      </Modal>
      <Modal
        visible={historyNote !== null}
        animationType="slide"
        onRequestClose={() => setHistoryNote(null)}
      >
        {historyNote && store.current && (
          <NoteHistoryScreen
            key={historyNote.id}
            note={historyNote}
            records={records}
            store={store.current}
            client={client}
            onClose={() => setHistoryNote(null)}
            onRestored={async () => {
              setHistoryNote(null);
              setStatus('Version restored on this device. Sync pending.');
              await refreshLocal();
              void sync();
            }}
          />
        )}
      </Modal>
      <Modal
        visible={folderScreen}
        animationType="slide"
        onRequestClose={() => setFolderScreen(false)}
      >
        {folderScreen && store.current && (
          <FolderScreen
            records={records}
            pendingIds={pendingIds}
            note={filingNote}
            store={store.current}
            onClose={() => setFolderScreen(false)}
            onChanged={async () => {
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
