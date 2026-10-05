import { useEffect, useState } from 'react';
import { Alert, Linking, Modal, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createClient } from '@personalspace/api-client';
import type {
  PreferencesResponse,
  ExportJobResponse,
  DeletionStatusResponse,
} from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';

type ExportFormat = 'json' | 'csv' | 'markdown';
type ExportScope = 'everything' | 'notes' | 'tasks' | 'learning' | 'money';

export function SettingsScreen({
  visible,
  onClose,
  client,
  onSignOut,
}: {
  visible: boolean;
  onClose: () => void;
  client: ReturnType<typeof createClient>;
  onSignOut: () => void;
}) {
  const [settings, setSettings] = useState<PreferencesResponse | null>(null);
  const [exports, setExports] = useState<ExportJobResponse[]>([]);
  const [deletion, setDeletion] = useState<DeletionStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('json');
  const [exportScope, setExportScope] = useState<ExportScope>('everything');
  const [deleteConfirm, setDeleteConfirm] = useState('');

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setDeleteConfirm('');
    Promise.all([
      client.getSettings().then(setSettings),
      client.listExports().then((res) => setExports(res.data)),
      client.getDeletionStatus().then(setDeletion),
    ])
      .catch((e) => Alert.alert('Error loading settings', String(e)))
      .finally(() => setLoading(false));
  }, [visible, client]);

  useEffect(() => {
    if (!visible || !exports.some((job) => ['queued', 'processing'].includes(job.status))) return;
    let alive = true;
    const timer = setInterval(() => {
      void client
        .listExports()
        .then((result) => {
          if (alive) setExports(result.data);
        })
        .catch(() => {});
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [visible, client, exports]);

  async function downloadExport(id: string) {
    setSaving(true);
    try {
      const grant = await client.downloadExport(id);
      await Linking.openURL(grant.url);
    } catch {
      Alert.alert(
        'Export unavailable',
        'Refresh the list or create a new export. Downloads expire after 24 hours.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function refreshExports() {
    setSaving(true);
    try {
      setExports((await client.listExports()).data);
    } catch {
      Alert.alert('Could not refresh exports', 'Try again when connected.');
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    setSaving(true);
    try {
      const res = await client.startExport({ format: exportFormat, scope: exportScope });
      setExports([res, ...exports]);
      Alert.alert(
        'Export started',
        'Keep this screen open to see progress, or return and refresh the list.',
      );
    } catch (e) {
      Alert.alert('Export failed', String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (deleteConfirm !== 'DELETE') {
      Alert.alert('Confirmation required', 'Type DELETE to confirm account deletion.');
      return;
    }
    Alert.alert(
      'Delete Account',
      'This is your final confirmation. All data will be permanently deleted after 14 days.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete My Account',
          style: 'destructive',
          onPress: async () => {
            setSaving(true);
            try {
              const res = await client.requestDeletion({ confirmText: 'DELETE' });
              setDeletion(res);
              setDeleteConfirm('');
              Alert.alert(
                'Deletion scheduled',
                `Your account will be permanently deleted on ${new Date(res.graceEndsAt!).toLocaleDateString()}. You can cancel anytime before then.`,
              );
            } catch (e) {
              Alert.alert('Deletion failed', String(e));
            } finally {
              setSaving(false);
            }
          },
        },
      ],
    );
  }

  async function handleCancelDelete() {
    setSaving(true);
    try {
      const res = await client.cancelDeletion();
      setDeletion(res);
      Alert.alert('Deletion cancelled', 'Your account is safe. All data has been preserved.');
    } catch (e) {
      Alert.alert('Failed to cancel deletion', String(e));
    } finally {
      setSaving(false);
    }
  }

  const formats: { key: ExportFormat; label: string }[] = [
    { key: 'json', label: 'JSON' },
    { key: 'csv', label: 'CSV' },
    { key: 'markdown', label: 'Markdown' },
  ];
  const scopes: { key: ExportScope; label: string }[] = [
    { key: 'everything', label: 'Everything' },
    { key: 'notes', label: 'Notes' },
    { key: 'tasks', label: 'Tasks' },
    { key: 'learning', label: 'Learning' },
    { key: 'money', label: 'Money' },
  ];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <ScrollView contentContainerStyle={styles.page}>
          <View style={[styles.row, { justifyContent: 'space-between' }]}>
            <Text style={styles.eyebrow}>SETTINGS</Text>
            <Button secondary label="Close" onPress={onClose} disabled={saving} />
          </View>

          <Text style={styles.title}>Your Account</Text>

          {loading ? (
            <Text style={styles.subtitle}>Loading settings...</Text>
          ) : (
            <>
              {settings && (
                <Card>
                  <Text style={styles.label}>Preferences</Text>
                  <Text style={styles.subtitle}>Timezone: {settings.timezone}</Text>
                  <Text style={styles.subtitle}>Theme: {settings.theme}</Text>
                  <Text style={styles.subtitle}>Currency: {settings.baseCurrency}</Text>
                  <Text style={styles.subtitle}>Text size: {settings.textSize}</Text>
                </Card>
              )}

              <Card>
                <Text style={styles.label}>Session</Text>
                <Text style={styles.subtitle}>
                  Signing out keeps this account&apos;s unsynced data on the device.
                </Text>
                <Button secondary label="Sign out" onPress={onSignOut} disabled={saving} />
              </Card>

              <Text style={[styles.title, { marginTop: 24 }]}>Data &amp; Export</Text>

              <Card>
                <Text style={styles.label}>Export your data</Text>
                <Text style={styles.subtitle}>
                  Export selected records, up to 25 MB. Attachments and version history are not
                  included. CSV and Markdown download as ZIP files. Ready downloads are available
                  for 24 hours.
                </Text>

                <Text style={styles.label}>Format</Text>
                <View style={styles.row}>
                  {formats.map((f) => (
                    <Button
                      key={f.key}
                      secondary={exportFormat !== f.key}
                      label={f.label}
                      onPress={() => setExportFormat(f.key)}
                    />
                  ))}
                </View>

                <Text style={styles.label}>Scope</Text>
                <View style={styles.row}>
                  {scopes.map((s) => (
                    <Button
                      key={s.key}
                      secondary={exportScope !== s.key}
                      label={s.label}
                      onPress={() => setExportScope(s.key)}
                    />
                  ))}
                </View>

                <Button
                  label={
                    saving ? 'Starting…' : `Export ${exportScope} as ${exportFormat.toUpperCase()}`
                  }
                  onPress={() => void handleExport()}
                  disabled={saving}
                />
                <Button
                  secondary
                  label="Refresh exports"
                  disabled={saving}
                  onPress={() => void refreshExports()}
                />

                {exports.length > 0 && (
                  <View style={{ marginTop: 12, gap: 8 }}>
                    <Text style={styles.label}>Recent Exports</Text>
                    {exports.slice(0, 5).map((job) => (
                      <View key={job.id} style={{ gap: 6 }}>
                        <Text style={styles.subtitle}>
                          {new Date(job.createdAt).toLocaleDateString()} ·{' '}
                          {job.format.toUpperCase()} · {job.scope}
                        </Text>
                        <Text
                          style={[
                            styles.subtitle,
                            {
                              color:
                                job.status === 'ready'
                                  ? '#2D6A4F'
                                  : job.status === 'failed'
                                    ? '#D62828'
                                    : '#666',
                            },
                          ]}
                        >
                          {job.status.toUpperCase()}
                          {job.sizeBytes ? ` · ${(job.sizeBytes / 1024).toFixed(0)} KB` : ''}
                        </Text>
                        {job.status === 'ready' && (
                          <Button
                            label="Download export"
                            disabled={saving}
                            onPress={() => void downloadExport(job.id)}
                          />
                        )}
                      </View>
                    ))}
                  </View>
                )}
              </Card>

              <Text style={[styles.title, { marginTop: 24, color: '#D62828' }]}>Danger Zone</Text>

              <Card>
                {deletion && deletion.status !== 'none' && deletion.status !== 'cancelled' ? (
                  <>
                    <Text style={[styles.label, { color: '#D62828' }]}>
                      ⚠ Account deletion scheduled
                    </Text>
                    <Text style={styles.subtitle}>
                      Your account and all associated data will be permanently deleted on{' '}
                      {new Date(deletion.graceEndsAt!).toLocaleDateString()}.
                    </Text>
                    <Text style={styles.subtitle}>
                      You can cancel deletion any time before that date. After the grace period,
                      deletion is irreversible.
                    </Text>
                    <Button
                      label="Cancel Deletion"
                      onPress={() => void handleCancelDelete()}
                      disabled={saving}
                    />
                  </>
                ) : (
                  <>
                    <Text style={[styles.label, { color: '#D62828' }]}>Delete Account</Text>
                    <Text style={styles.subtitle}>
                      Permanently delete your account and all data. After requesting deletion, you
                      have a 14-day grace period during which you can cancel.
                    </Text>
                    <Text style={styles.subtitle}>We recommend exporting your data first.</Text>
                    <Field
                      label="Type DELETE to confirm"
                      value={deleteConfirm}
                      onChangeText={setDeleteConfirm}
                      autoCapitalize="characters"
                      maxLength={6}
                    />
                    <Button
                      label={saving ? 'Processing…' : 'Delete Account'}
                      onPress={() => void handleDelete()}
                      disabled={saving || deleteConfirm !== 'DELETE'}
                    />
                  </>
                )}
              </Card>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
