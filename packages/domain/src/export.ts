/**
 * Export data generator — builds JSON/CSV export archives (§20.1).
 *
 * Exports run as background jobs. Each scope queries all user data
 * from the relevant tables and produces a structured output.
 */

import { eq, isNull, and } from 'drizzle-orm';
import {
  notes,
  tasks,
  noteFolders,
  projects,
  reminders,
  learningCollections,
  learningResources,
  people,
  financeAccounts,
  financeCategories,
  debts,
  financeTransactions,
  transactionSplits,
  type Database,
} from '@personalspace/db';

export type ExportScope = 'everything' | 'notes' | 'tasks' | 'learning' | 'money';
export type ExportFormat = 'json' | 'csv' | 'markdown';

interface ExportData {
  exportedAt: string;
  scope: ExportScope;
  notes?: unknown[];
  folders?: unknown[];
  tasks?: unknown[];
  projects?: unknown[];
  reminders?: unknown[];
  learningCollections?: unknown[];
  learningResources?: unknown[];
  people?: unknown[];
  accounts?: unknown[];
  categories?: unknown[];
  debts?: unknown[];
  transactions?: unknown[];
}

/** Generate the full export data for a user. */
export async function generateExportData(
  db: Database,
  userId: string,
  scope: ExportScope,
): Promise<ExportData> {
  const data: ExportData = {
    exportedAt: new Date().toISOString(),
    scope,
  };

  if (scope === 'everything' || scope === 'notes') {
    data.notes = await db
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), isNull(notes.deletedAt)));
    data.folders = await db
      .select()
      .from(noteFolders)
      .where(and(eq(noteFolders.userId, userId), isNull(noteFolders.deletedAt)));
  }

  if (scope === 'everything' || scope === 'tasks') {
    data.tasks = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)));
    data.projects = await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), isNull(projects.deletedAt)));
    data.reminders = await db
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), isNull(reminders.deletedAt)));
  }

  if (scope === 'everything' || scope === 'learning') {
    data.learningCollections = await db
      .select()
      .from(learningCollections)
      .where(and(eq(learningCollections.userId, userId), isNull(learningCollections.deletedAt)));
    data.learningResources = await db
      .select()
      .from(learningResources)
      .where(and(eq(learningResources.userId, userId), isNull(learningResources.deletedAt)));
  }

  if (scope === 'everything' || scope === 'money') {
    data.people = await db
      .select()
      .from(people)
      .where(and(eq(people.userId, userId), isNull(people.deletedAt)));
    data.accounts = await db
      .select()
      .from(financeAccounts)
      .where(and(eq(financeAccounts.userId, userId), isNull(financeAccounts.deletedAt)));
    data.categories = await db
      .select()
      .from(financeCategories)
      .where(and(eq(financeCategories.userId, userId), isNull(financeCategories.deletedAt)));
    data.debts = await db
      .select()
      .from(debts)
      .where(and(eq(debts.userId, userId), isNull(debts.deletedAt)));
    const txns = await db
      .select()
      .from(financeTransactions)
      .where(eq(financeTransactions.userId, userId));
    // Attach splits to each transaction.
    const txnIds = txns.map((t) => t.id);
    const allSplits = txnIds.length
      ? await db
          .select()
          .from(transactionSplits)
          .where(and(eq(transactionSplits.userId, userId)))
      : [];
    const splitsByTx = new Map<string, typeof allSplits>();
    for (const split of allSplits) {
      let arr = splitsByTx.get(split.transactionId);
      if (!arr) {
        arr = [];
        splitsByTx.set(split.transactionId, arr);
      }
      arr.push(split);
    }
    data.transactions = txns.map((t) => ({
      ...t,
      splits: splitsByTx.get(t.id) ?? [],
    }));
  }

  return data;
}

/** Convert export data to JSON string. */
export function exportToJson(data: ExportData): string {
  return JSON.stringify(data, null, 2);
}

/** Convert export data to CSV. Only applicable for flat entity types. */
export function exportToCsv(data: ExportData): Record<string, string> {
  const files: Record<string, string> = {};

  if (data.tasks?.length) {
    files['tasks.csv'] = toCsv(data.tasks as Record<string, unknown>[]);
  }
  if (data.notes?.length) {
    files['notes.csv'] = toCsv(
      (data.notes as Record<string, unknown>[]).map((n) => ({
        id: n.id,
        title: n.title,
        status: n.status,
        folderId: n.folderId,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      })),
    );
  }
  if (data.transactions?.length) {
    files['transactions.csv'] = toCsv(
      (data.transactions as Record<string, unknown>[]).map((t) => ({
        id: t.id,
        type: t.transactionType,
        amount: t.amountMinor,
        currency: t.currency,
        date: t.transactionDate,
        description: t.description,
        merchant: t.merchant,
        status: t.status,
        accountId: t.accountId,
      })),
    );
  }
  if (data.accounts?.length) {
    files['accounts.csv'] = toCsv(data.accounts as Record<string, unknown>[]);
  }
  if (data.people?.length) {
    files['people.csv'] = toCsv(data.people as Record<string, unknown>[]);
  }
  if (data.debts?.length) {
    files['debts.csv'] = toCsv(data.debts as Record<string, unknown>[]);
  }

  return files;
}

/** Simple CSV serializer for an array of objects. */
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]!);
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
  ].join('\n');
}
