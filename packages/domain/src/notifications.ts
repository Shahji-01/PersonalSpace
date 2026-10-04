/**
 * Push notification and reminders delivery worker (§50).
 *
 * Queries due reminders and dispatches push notifications to registered
 * device tokens. Avoids sending pushes to devices that have recently
 * synced and scheduled the reminder locally.
 */

import { eq, and, lte, isNull, inArray, or, sql } from 'drizzle-orm';
import {
  reminders,
  deviceTokens,
  notificationLog,
  type Database,
} from '@personalspace/db';

export async function deliverDueReminders(db: Database): Promise<number> {
  const now = new Date();

  // Find all due reminders that haven't been fired for their current fire_at time.
  const due = await db
    .select({
      id: reminders.id,
      userId: reminders.userId,
      title: reminders.title,
      fireAt: reminders.fireAt,
    })
    .from(reminders)
    .where(
      and(
        inArray(reminders.status, ['scheduled', 'snoozed']),
        lte(reminders.fireAt, now),
        or(
          isNull(reminders.lastFiredAt),
          sql`${reminders.lastFiredAt} < ${reminders.fireAt}`,
        ),
        isNull(reminders.deletedAt),
      ),
    )
    .limit(100);

  if (!due.length) return 0;

  let deliveries = 0;

  for (const reminder of due) {
    // Find devices that need a server push.
    // Devices with remindersScheduledThrough >= reminder.fireAt have it scheduled locally.
    const devices = await db
      .select()
      .from(deviceTokens)
      .where(
        and(
          eq(deviceTokens.userId, reminder.userId),
          or(
            isNull(deviceTokens.remindersScheduledThrough),
            sql`${deviceTokens.remindersScheduledThrough} < ${reminder.fireAt}`,
          ),
        ),
      );

    const logsToInsert = devices.map((device) => ({
      userId: reminder.userId,
      type: 'reminder',
      channel: 'push',
      title: reminder.title,
      body: 'Scheduled reminder',
      entityId: reminder.id,
      // dedupeKey prevents sending the exact same push reminder instance to the same token twice.
      dedupeKey: `push:${device.token}:rem:${reminder.id}:${reminder.fireAt.getTime()}`,
    }));

    if (logsToInsert.length > 0) {
      await db
        .insert(notificationLog)
        .values(logsToInsert)
        .onConflictDoNothing();
      
      deliveries += logsToInsert.length;
    }

    // Mark as fired
    await db
      .update(reminders)
      .set({ lastFiredAt: now, updatedAt: now })
      .where(eq(reminders.id, reminder.id));
  }

  return deliveries;
}
