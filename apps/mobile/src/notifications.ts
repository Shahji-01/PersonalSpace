/**
 * Notification scheduling and device token registration (§50, M2).
 *
 * Handles:
 * 1. Requesting notification permissions
 * 2. Registering push tokens with the API
 * 3. Scheduling local notifications for reminders
 * 4. Syncing the local scheduling watermark
 */

import { Platform } from 'react-native';
import { createClient } from '@personalspace/api-client';
import type { RecordItem } from '@personalspace/validation';

// These are dynamically imported to avoid crashes when Expo Notifications
// isn't available (e.g. in web or test environments).
let Notifications: typeof import('expo-notifications') | null = null;
let Device: typeof import('expo-device') | null = null;

try {
  // Metro resolves these native modules at runtime; a dynamic require lets the app
  // degrade gracefully where Expo Notifications is unavailable (web, tests).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Notifications = require('expo-notifications');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Device = require('expo-device');
} catch {
  // Not available in this environment
}

/**
 * Request notification permissions and return the Expo push token.
 * Returns null if permissions are denied or unavailable.
 */
export async function requestNotificationPermission(): Promise<string | null> {
  if (!Notifications || !Device) return null;

  // Physical device check
  if (!Device.isDevice) {
    console.warn('Notifications require a physical device');
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return null;
  }

  // Configure notification channel for Android
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('reminders', {
      name: 'Reminders',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#2D6A4F',
    });
  }

  try {
    const tokenData = await Notifications.getExpoPushTokenAsync();
    return tokenData.data;
  } catch {
    // Fall back to device push token
    try {
      const deviceToken = await Notifications.getDevicePushTokenAsync();
      return deviceToken.data as string;
    } catch {
      return null;
    }
  }
}

/**
 * Register the device push token with the API server.
 * Returns the device ID assigned by the server.
 */
export async function registerDeviceToken(
  client: ReturnType<typeof createClient>,
  token: string,
): Promise<string | null> {
  try {
    const platform = Platform.OS === 'ios' ? 'ios' as const : 'android' as const;
    const result = await client.registerDevice({
      platform,
      token,
      appVersion: '0.1.0',
    });
    return result.data.id;
  } catch (e) {
    console.warn('Failed to register device token:', e);
    return null;
  }
}

/**
 * Schedule local notifications for upcoming reminders.
 * Only schedules reminders that fire within the next 7 days.
 */
export async function scheduleLocalReminders(reminders: RecordItem[]): Promise<string | null> {
  if (!Notifications) return null;

  // Cancel all existing reminder notifications first
  await Notifications.cancelAllScheduledNotificationsAsync();

  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  let latestScheduled: string | null = null;

  for (const reminder of reminders) {
    if (reminder.type !== 'reminder') continue;
    if (reminder.deletedAt) continue;
    if (reminder.status !== 'scheduled' && reminder.status !== 'snoozed') continue;
    if (!reminder.fireAt) continue;

    const fireDate = new Date(reminder.fireAt);
    if (fireDate <= now || fireDate > sevenDaysFromNow) continue;

    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Reminder',
          body: reminder.text || 'You have a reminder',
          data: { reminderId: reminder.id, entityId: reminder.entityId },
          sound: true,
          ...(Platform.OS === 'android' ? { channelId: 'reminders' } : {}),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireDate,
        },
      });

      // Track the latest scheduled time for the watermark
      if (!latestScheduled || reminder.fireAt > latestScheduled) {
        latestScheduled = reminder.fireAt;
      }
    } catch (e) {
      console.warn('Failed to schedule notification for reminder:', reminder.id, e);
    }
  }

  return latestScheduled;
}

/**
 * Update the device watermark on the server so the backend
 * knows which reminders this device has already scheduled locally.
 */
export async function updateDeviceWatermark(
  client: ReturnType<typeof createClient>,
  deviceId: string,
  watermark: string,
): Promise<void> {
  try {
    await client.updateDeviceWatermark(deviceId, {
      remindersScheduledThrough: watermark,
    });
  } catch (e) {
    console.warn('Failed to update device watermark:', e);
  }
}

/**
 * Full notification setup flow:
 * 1. Request permissions
 * 2. Register push token
 * 3. Schedule local notifications for upcoming reminders
 * 4. Update the server watermark
 */
export async function setupNotifications(
  client: ReturnType<typeof createClient>,
  reminders: RecordItem[],
): Promise<{ token: string | null; deviceId: string | null; scheduled: number }> {
  const token = await requestNotificationPermission();
  let deviceId: string | null = null;

  if (token) {
    deviceId = await registerDeviceToken(client, token);
  }

  const watermark = await scheduleLocalReminders(reminders);
  let scheduledCount = 0;

  if (watermark && deviceId) {
    await updateDeviceWatermark(client, deviceId, watermark);
    scheduledCount = reminders.filter(
      (r) =>
        r.type === 'reminder' &&
        !r.deletedAt &&
        (r.status === 'scheduled' || r.status === 'snoozed') &&
        r.fireAt &&
        new Date(r.fireAt) > new Date() &&
        new Date(r.fireAt) <= new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ).length;
  }

  return { token, deviceId, scheduled: scheduledCount };
}
