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
  const [library, setLibrary] = useState<'inbox' | 'note'>('inbox');
  const [allTasks, setAllTasks] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
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
  const today = localDate();
  const inboxCount = records.filter((r) => r.type === 'inbox' && r.status === 'new').length;
  const visible = records.filter(
    (r) =>
      !r.deletedAt &&
      (tab === 'today'
        ? r.type === 'task' && (allTasks || r.plannedDate === today)
        : r.type === library && r.status !== 'converted'),
  );
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
          </View>
        )}
        {!visible.length && (
          <Card>
            <Text style={[styles.title, { fontSize: 24 }]}>
              {tab === 'today'
                ? 'Make room for what matters.'
                : library === 'inbox'
                  ? 'A clear inbox.'
                  : 'Your notes will live here.'}
            </Text>
            <Text style={styles.subtitle}>
              {tab === 'today'
                ? 'Add one thing you want to do today.'
                : 'A thought, an idea, something to remember. Save it in a moment.'}
            </Text>
            <Button label="Capture something" onPress={() => setCaptureOpen(true)} />
          </Card>
        )}
        {visible.map((record) => (
          <Card key={record.id}>
            <Text
              style={[
                styles.label,
                { fontSize: 18, lineHeight: 26 },
                record.status === 'done' && { textDecorationLine: 'line-through' },
              ]}
            >
              {record.text}
            </Text>
            <Text style={styles.subtitle}>
              {pendingIds.includes(record.id) || record.version === 0
                ? 'Saved locally · not synced'
                : record.type === 'task'
                  ? record.status === 'done'
                    ? 'Completed'
                    : (record.plannedDate ?? 'No planned date')
                  : 'Saved'}
            </Text>
            {record.type === 'task' && (
              <Button
                secondary
                disabled={pendingIds.includes(record.id) || record.version === 0}
                label={record.status === 'done' ? 'Reopen task' : 'Mark complete'}
                onPress={() => void act(record)}
              />
            )}
            {record.type === 'inbox' && (
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
    </>
  );
}
function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
