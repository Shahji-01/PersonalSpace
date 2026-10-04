import { useEffect, useState } from 'react';
import { Alert, Modal, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createClient } from '@personalspace/api-client';
import type { PreferencesResponse, ExportJobResponse, DeletionStatusResponse } from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';

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

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    Promise.all([
      client.getSettings().then(setSettings),
      client.listExports().then((res) => setExports(res.data)),
      client.getDeletionStatus().then(setDeletion),
    ])
      .catch((e) => Alert.alert('Error loading settings', String(e)))
      .finally(() => setLoading(false));
  }, [visible, client]);

  async function handleExport() {
    setSaving(true);
    try {
      const res = await client.startExport({ format: 'json', scope: 'everything' });
      setExports([res, ...exports]);
      Alert.alert('Export started', 'You will receive an email when your export is ready.');
    } catch (e) {
      Alert.alert('Export failed', String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    Alert.alert(
      'Delete Account',
      'Are you absolutely sure? This will delete all your data.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSaving(true);
            try {
              const res = await client.requestDeletion({ confirmText: 'DELETE' });
              setDeletion(res);
              Alert.alert('Deletion started', 'Your account will be deleted in 14 days.');
            } catch (e) {
              Alert.alert('Deletion failed', String(e));
            } finally {
              setSaving(false);
            }
          },
        },
      ]
    );
  }

  async function handleCancelDelete() {
    setSaving(true);
    try {
      const res = await client.cancelDeletion();
      setDeletion(res);
      Alert.alert('Deletion cancelled', 'Your account is safe.');
    } catch (e) {
      Alert.alert('Failed to cancel deletion', String(e));
    } finally {
      setSaving(false);
    }
  }

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
                </Card>
              )}

              <Text style={[styles.title, { marginTop: 24 }]}>Data & Export</Text>
              
              <Card>
                <Text style={styles.label}>Export your data</Text>
                <Text style={styles.subtitle}>
                  Download a complete backup of all your notes, tasks, and history.
                </Text>
                <Button label="Request JSON Export" onPress={() => void handleExport()} disabled={saving} />
                
                {exports.length > 0 && (
                  <View style={{ marginTop: 12, gap: 8 }}>
                    <Text style={styles.label}>Recent Exports</Text>
                    {exports.slice(0, 3).map((job) => (
                      <Text key={job.id} style={styles.subtitle}>
                        {new Date(job.createdAt).toLocaleDateString()} - {job.status.toUpperCase()}
                      </Text>
                    ))}
                  </View>
                )}
              </Card>

              <Text style={[styles.title, { marginTop: 24, color: 'red' }]}>Danger Zone</Text>

              <Card>
                {deletion && deletion.status !== 'none' && deletion.status !== 'cancelled' ? (
                  <>
                    <Text style={[styles.label, { color: 'red' }]}>Account deletion pending</Text>
                    <Text style={styles.subtitle}>
                      Your account is scheduled for deletion on {new Date(deletion.graceEndsAt!).toLocaleDateString()}.
                    </Text>
                    <Button label="Cancel Deletion" onPress={() => void handleCancelDelete()} disabled={saving} />
                  </>
                ) : (
                  <>
                    <Text style={[styles.label, { color: 'red' }]}>Delete Account</Text>
                    <Text style={styles.subtitle}>
                      Permanently delete your account and all data. There is a 14-day grace period.
                    </Text>
                    <Button label="Delete Account" onPress={() => void handleDelete()} disabled={saving} />
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
