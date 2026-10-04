import { eq } from 'drizzle-orm';
import { userPreferences, type Database } from '@personalspace/db';
import type { PreferencesUpdate } from '@personalspace/validation';

/**
 * Get user preferences, creating defaults if none exist.
 * Uses INSERT ... ON CONFLICT to handle concurrent first reads.
 */
export async function getPreferences(db: Database, userId: string) {
  const existing = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  if (existing.length) return serialize(existing[0]!);
  // Create defaults on first access.
  const inserted = await db
    .insert(userPreferences)
    .values({ userId })
    .onConflictDoNothing()
    .returning();
  if (inserted.length) return serialize(inserted[0]!);
  // Another transaction created it concurrently — re-read.
  const retry = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  return serialize(retry[0]!);
}

/**
 * Update preferences. Upserts: creates defaults for missing rows,
 * then applies the patch atomically.
 */
export async function updatePreferences(
  db: Database,
  userId: string,
  input: PreferencesUpdate,
) {
  // Ensure the row exists before patching.
  await db
    .insert(userPreferences)
    .values({ userId })
    .onConflictDoNothing();

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) patch[key] = value;
  }

  const updated = await db
    .update(userPreferences)
    .set(patch)
    .where(eq(userPreferences.userId, userId))
    .returning();
  return serialize(updated[0]!);
}

function serialize(row: typeof userPreferences.$inferSelect) {
  return {
    timezone: row.timezone,
    locale: row.locale,
    weekStartDay: row.weekStartDay,
    baseCurrency: row.baseCurrency,
    morningStart: row.morningStart.slice(0, 5),
    afternoonStart: row.afternoonStart.slice(0, 5),
    eveningStart: row.eveningStart.slice(0, 5),
    nightStart: row.nightStart.slice(0, 5),
    defaultAccountId: row.defaultAccountId,
    defaultPaymentMethod: row.defaultPaymentMethod,
    captureTarget: row.captureTarget,
    quietHoursStart: row.quietHoursStart.slice(0, 5),
    quietHoursEnd: row.quietHoursEnd.slice(0, 5),
    notificationReminder: row.notificationReminder,
    notificationTaskDue: row.notificationTaskDue,
    notificationDebtDue: row.notificationDebtDue,
    notificationExport: row.notificationExport,
    aiEnabled: row.aiEnabled,
    aiMemoryEnabled: row.aiMemoryEnabled,
    aiConversationRetentionDays: row.aiConversationRetentionDays,
    appLockEnabled: row.appLockEnabled,
    appLockTimeoutMinutes: row.appLockTimeoutMinutes,
    hideInSwitcher: row.hideInSwitcher,
    analyticsOptOut: row.analyticsOptOut,
    theme: row.theme,
    textSize: row.textSize,
  };
}
