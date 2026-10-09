import { useEffect, useState } from 'react';
import { Alert, Linking, Modal, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createClient } from '@personalspace/api-client';
import type {
  PreferencesResponse,
  PreferencesUpdate,
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
  const canCancelDeletion =
    deletion?.status === 'pending' &&
    !!deletion.graceEndsAt &&
    Date.parse(deletion.graceEndsAt) > Date.now();

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

  async function savePref(update: PreferencesUpdate) {
    setSaving(true);
    try {
      setSettings(await client.updateSettings(update));
    } catch (e) {
      Alert.alert('Could not save preference', String(e));
    } finally {
      setSaving(false);
    }
  }

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
                `Deletion starts after ${new Date(res.graceEndsAt!).toLocaleString()}. You can cancel before then.`,
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
                  <Text style={styles.label}>Appearance</Text>
                  <Text style={styles.subtitle}>Theme</Text>
                  <View style={styles.row}>
                    {(['system', 'light', 'dark'] as const).map((t) => (
                      <Button
                        key={t}
                        secondary={settings.theme !== t}
                        label={t}
                        disabled={saving}
                        onPress={() => void savePref({ theme: t })}
                      />
                    ))}
                  </View>
                  <Text style={styles.subtitle}>Text size</Text>
                  <View style={styles.row}>
                    {(['system', 'small', 'medium', 'large'] as const).map((t) => (
                      <Button
                        key={t}
                        secondary={settings.textSize !== t}
                        label={t}
                        disabled={saving}
                        onPress={() => void savePref({ textSize: t })}
                      />
                    ))}
                  </View>

                  <Text style={[styles.label, { marginTop: 12 }]}>Capture &amp; week</Text>
                  <Text style={styles.subtitle}>Default capture destination</Text>
                  <View style={styles.row}>
                    {(['inbox', 'note', 'task'] as const).map((t) => (
                      <Button
                        key={t}
                        secondary={settings.captureTarget !== t}
                        label={t}
                        disabled={saving}
                        onPress={() => void savePref({ captureTarget: t })}
                      />
                    ))}
                  </View>
                  <Text style={styles.subtitle}>Week starts on</Text>
                  <View style={styles.row}>
                    <Button
                      secondary={settings.weekStartDay !== 0}
                      label="Sunday"
                      disabled={saving}
                      onPress={() => void savePref({ weekStartDay: 0 })}
                    />
                    <Button
                      secondary={settings.weekStartDay !== 1}
                      label="Monday"
                      disabled={saving}
                      onPress={() => void savePref({ weekStartDay: 1 })}
                    />
                  </View>

                  <Text style={[styles.label, { marginTop: 12 }]}>Notifications</Text>
                  {(
                    [
                      ['notificationReminder', 'Reminders'],
                      ['notificationTaskDue', 'Task due dates'],
                      ['notificationDebtDue', 'Debt due dates'],
                      ['notificationExport', 'Export ready'],
                    ] as const
                  ).map(([key, label]) => (
                    <View key={key} style={[styles.row, { justifyContent: 'space-between' }]}>
                      <Text style={[styles.subtitle, { flex: 1 }]}>{label}</Text>
                      <Switch
                        value={settings[key]}
                        disabled={saving}
                        onValueChange={(value) =>
                          void savePref({ [key]: value } as PreferencesUpdate)
                        }
                      />
                    </View>
                  ))}

                  <View style={[styles.row, { justifyContent: 'space-between', marginTop: 12 }]}>
                    <Text style={[styles.subtitle, { flex: 1 }]}>Opt out of analytics</Text>
                    <Switch
                      value={settings.analyticsOptOut}
                      disabled={saving}
                      onValueChange={(value) => void savePref({ analyticsOptOut: value })}
                    />
                  </View>

                  <Text style={[styles.subtitle, { marginTop: 12 }]}>
                    Timezone {settings.timezone} · Currency {settings.baseCurrency}
                  </Text>
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
                      {deletion.status === 'completed'
                        ? 'Account deleted'
                        : canCancelDeletion
                          ? 'Account deletion scheduled'
                          : 'Account deletion in progress'}
                    </Text>
                    <Text style={styles.subtitle}>
                      {canCancelDeletion
                        ? `You can cancel until ${new Date(deletion.graceEndsAt!).toLocaleString()}.`
                        : deletion.status === 'completed'
                          ? 'Account cleanup has completed.'
                          : 'The cancellation period has ended. Your account data and files are being removed.'}
                    </Text>
                    <Text style={styles.subtitle}>
                      {canCancelDeletion
                        ? 'After the grace period, deletion is irreversible.'
                        : deletion.status === 'completed'
                          ? 'Your account can no longer be used.'
                          : 'File cleanup may take additional time while existing upload links expire.'}
                    </Text>
                    {canCancelDeletion && (
                      <Button
                        label="Cancel Deletion"
                        onPress={() => void handleCancelDelete()}
                        disabled={saving}
                      />
                    )}
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
