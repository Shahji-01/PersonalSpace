import { useEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AttachmentRuntime } from './attachment-runtime';
import type { AttachmentCacheUsage } from './attachment-cache';
import { cacheLimitsMb } from './attachment-cache-store';
import { Button, Card, styles } from './components';

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
export function StorageScreen({
  runtime,
  onClose,
}: {
  runtime: AttachmentRuntime;
  onClose: () => void;
}) {
  const [usage, setUsage] = useState<AttachmentCacheUsage | null>(null);
  const [tick, setTick] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => runtime.subscribe(() => setTick((value) => value + 1)), [runtime]);
  useEffect(() => {
    let alive = true;
    void runtime
      .storageUsage()
      .then((value) => {
        if (alive) setUsage(value);
      })
      .catch(() => {
        if (alive) setError('Could not read file storage. Please try again.');
      });
    return () => {
      alive = false;
    };
  }, [runtime, tick]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch {
      setError('Could not update storage. Your protected files are kept; please try again.');
    } finally {
      setBusy(false);
      setTick((value) => value + 1);
    }
  };
  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>SETTINGS</Text>
        <Text style={styles.title}>File storage</Text>
        <Text style={styles.subtitle}>
          Files for this account on this device. Note text and other app data are separate.
        </Text>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {usage && (
          <>
            <Card>
              <Text style={styles.label}>
                {mb(usage.originalBytes + usage.downloadedBytes)} used by files
              </Text>
              <Text style={styles.subtitle}>Local upload copies: {mb(usage.originalBytes)}</Text>
              <Text style={styles.subtitle}>Files and previews: {mb(usage.downloadedBytes)}</Text>
              <Text style={styles.subtitle}>Kept offline: {mb(usage.pinnedBytes)}</Text>
            </Card>
            <Text style={styles.label}>Download cache limit</Text>
            <View style={styles.row}>
              {cacheLimitsMb.map((limit) => (
                <Button
                  key={limit}
                  label={`${limit} MB`}
                  secondary={usage.limitMb !== limit}
                  disabled={busy}
                  onPress={() => void action(() => runtime.setCacheLimitMb(limit))}
                />
              ))}
            </View>
            <Text style={styles.subtitle}>
              Older unused downloads are removed first. Files marked Keep offline stay available,
              even if they exceed this limit. Uploads awaiting confirmation are protected.
            </Text>
            <Text style={styles.subtitle}>
              Local upload copies are removed after the server confirms processing and sync
              completes. Keep offline preserves a downloaded copy for use without a connection.
            </Text>
            <Text style={styles.subtitle}>
              Recent image previews download automatically while the app is open, when space is
              available. Clearing the cache pauses this until the app next returns to the
              foreground.
            </Text>
            <Button
              secondary
              label={busy ? 'Working…' : 'Clear cache'}
              disabled={busy}
              onPress={() =>
                Alert.alert(
                  'Clear downloaded cache?',
                  'Downloaded files can be fetched again when online. Files kept offline and uploads awaiting confirmation stay on this device.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Clear cache', onPress: () => void action(runtime.clearCache) },
                  ],
                )
              }
            />
          </>
        )}
        <Button secondary label="Close" disabled={busy} onPress={onClose} />
      </ScrollView>
    </SafeAreaView>
  );
}
