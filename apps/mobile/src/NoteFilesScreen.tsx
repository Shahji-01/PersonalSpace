import { useEffect, useState } from 'react';
import { Alert, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AttachmentTransfer, RecordItem } from '@personalspace/validation';
import type { LocalStore } from './store';
import type { AttachmentRuntime } from './attachment-runtime';
import type { AttachmentCacheEntry } from './attachment-cache-store';
import { Button, Card, styles } from './components';

function transferLabel(
  job: AttachmentTransfer,
  network: ReturnType<AttachmentRuntime['status']> | undefined,
) {
  if (job.state === 'ready') return 'Ready';
  if (job.state === 'failed')
    return job.error === 'local_file'
      ? 'Local file unavailable. Choose it again.'
      : 'File not accepted. Remove it and choose another file.';
  if (job.state === 'auth_required') return 'Sign in again to resume';
  if (job.state === 'processing') return 'Processing…';
  if (!network?.connected) return 'Saved on this device · waiting for internet';
  if (job.descriptor.size > 10 * 1024 * 1024 && !network.wifi && !network.cellular)
    return 'Waiting for Wi-Fi';
  if (job.nextAttemptAt > Date.now()) return 'Waiting to retry';
  const bytes = job.parts.reduce(
    (sum, part) =>
      sum +
      Math.min(
        job.session?.partSize ?? 0,
        job.descriptor.size - (part.number - 1) * (job.session?.partSize ?? 0),
      ),
    0,
  );
  return job.state === 'uploading'
    ? `Uploading · ${Math.floor((bytes / job.descriptor.size) * 100)}%`
    : 'Queued';
}

export function NoteFilesScreen({
  note,
  records,
  store,
  runtime,
  unavailable,
  onClose,
}: {
  note: RecordItem;
  records: RecordItem[];
  store: LocalStore;
  runtime: AttachmentRuntime | null;
  unavailable: string;
  onClose: () => void;
}) {
  const [jobs, setJobs] = useState<AttachmentTransfer[]>([]),
    [removed, setRemoved] = useState<string[]>([]);
  const [cached, setCached] = useState<AttachmentCacheEntry[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [tick, setTick] = useState(0);
  const parent = records.find((item) => item.id === note.id);
  const available = !!parent && !parent.deletedAt && parent.version > 0;
  useEffect(() => runtime?.subscribe(() => setTick((value) => value + 1)), [runtime]);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      store.attachmentTransfers.list(),
      store.attachmentTransfers.removedIds(),
      store.attachmentCache.list(),
    ])
      .then(([items, ids, entries]) => {
        if (alive) {
          setJobs(items.filter((job) => job.descriptor.parentId === note.id));
          setRemoved(ids);
          setCached(entries);
        }
      })
      .catch(() => {
        if (alive) setError('Could not load files. Close and try again.');
      });
    return () => {
      alive = false;
    };
  }, [store, note.id, tick, records]);
  const metadata = records.filter(
    (item) =>
      item.type === 'attachment' && item.parentId === note.id && !item.deletedAt && item.attachment,
  );
  const ids = [
    ...new Set([...metadata.map((item) => item.id), ...jobs.map((job) => job.descriptor.id)]),
  ].filter((id) => !removed.includes(id));
  const network = runtime?.status();
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (reason) {
      setError(
        reason instanceof Error &&
          /^(Choose a file|This file type|Sync or restore|This note is no longer|Saving or sharing|Available when online)/.test(
            reason.message,
          )
          ? reason.message
          : 'Could not finish this action. Your saved files are kept; please try again.',
      );
    } finally {
      setBusy(false);
      setTick((value) => value + 1);
    }
  }
  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>NOTE FILES</Text>
        <Text style={styles.title}>Files</Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {note.text}
        </Text>
        <Text style={styles.subtitle}>
          Up to 25 MB per file. Files over 10 MB wait for Wi-Fi. Keep the app open while uploading.
        </Text>
        {!available && (
          <Text style={styles.error}>Sync or restore this note to manage its files.</Text>
        )}
        {!runtime && <Text style={styles.subtitle}>{unavailable || 'Opening file storage…'}</Text>}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {network?.authenticationRequired && (
          <Text style={styles.error}>Sign in again to resume file transfers.</Text>
        )}
        <Button
          label={busy ? 'Working…' : 'Add file'}
          disabled={busy || !runtime || !available}
          onPress={() => void action(() => runtime!.pick(note.id))}
        />
        {runtime && (
          <View style={styles.row}>
            <Switch
              accessibilityLabel="Allow large files on cellular for this session"
              value={network?.cellular ?? false}
              onValueChange={runtime.setCellular}
            />
            <Text style={styles.label}>Allow large files on cellular this session</Text>
          </View>
        )}
        {!ids.length && (
          <Card>
            <Text style={styles.subtitle}>
              No files attached yet. Add a photo, PDF, text document, or audio file.
            </Text>
          </Card>
        )}
        {ids.map((id) => {
          const job = jobs.find((item) => item.descriptor.id === id),
            remote = metadata.find((item) => item.id === id)?.attachment;
          const descriptor = remote ?? job?.descriptor;
          if (!descriptor) return null;
          const ready = remote?.status === 'ready' || job?.state === 'ready';
          const local = cached.find((entry) => entry.id === id);
          const label = ready
            ? local?.pinned
              ? 'Kept offline'
              : local
                ? 'Downloaded'
                : !network?.connected
                  ? 'Available when online'
                  : 'Ready'
            : remote?.status === 'rejected'
              ? 'File not accepted'
              : job
                ? transferLabel(job, network)
                : remote?.status === 'processing'
                  ? 'Processing…'
                  : 'Waiting for the device that added this file';
          return (
            <Card key={id}>
              <Text style={styles.label}>{descriptor.filename}</Text>
              <Text style={styles.subtitle}>
                {(descriptor.size / (1024 * 1024)).toFixed(2)} MB · {label}
              </Text>
              <View style={styles.row}>
                {ready && (
                  <>
                    <Button
                      secondary
                      label="Save or share"
                      disabled={busy || !runtime || !available}
                      onPress={() => void action(() => runtime!.share(id))}
                    />
                    <Button
                      secondary
                      label={local?.pinned ? 'Allow cache removal' : 'Keep offline'}
                      disabled={busy || !runtime || !available}
                      onPress={() =>
                        void action(() =>
                          local?.pinned ? runtime!.unpin(id) : runtime!.keepOffline(id),
                        )
                      }
                    />
                  </>
                )}
                {job?.error === 'retry' && (
                  <Button
                    secondary
                    label="Retry"
                    disabled={busy || !runtime || !available}
                    onPress={() => void action(() => runtime!.retry(id))}
                  />
                )}
                <Button
                  secondary
                  label="Remove"
                  disabled={busy || !runtime || !available}
                  onPress={() =>
                    Alert.alert(
                      'Remove file?',
                      'This removes the file from this note and queues deletion when you are online.',
                      [
                        { text: 'Keep', style: 'cancel' },
                        {
                          text: 'Remove',
                          style: 'destructive',
                          onPress: () => void action(() => runtime!.remove(id)),
                        },
                      ],
                    )
                  }
                />
              </View>
            </Card>
          );
        })}
        <Button secondary label="Close" disabled={busy} onPress={onClose} />
      </ScrollView>
    </SafeAreaView>
  );
}
