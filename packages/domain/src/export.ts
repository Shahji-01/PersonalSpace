/**
 * Export data generator — builds JSON/CSV export archives (§20.1).
 *
 * Exports run as background jobs. Each scope queries all user data
 * from the relevant tables and produces a structured output.
 */

import { eq, isNull, and } from 'drizzle-orm';
import { documentMarkdown, readDocument } from '@personalspace/editor-schema';
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

export interface ExportData {
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

const groups = [
  'notes',
  'folders',
  'tasks',
  'projects',
  'reminders',
  'learningCollections',
  'learningResources',
  'people',
  'accounts',
  'categories',
  'debts',
  'transactions',
] as const;

/** CSV keeps every selected column, including structured content/splits as JSON cells. */
export function exportToCsv(data: ExportData): Record<string, string> {
  const files: Record<string, string> = {};
  for (const group of groups) {
    const rows = data[group] as Record<string, unknown>[] | undefined;
    if (rows?.length) files[`${group}.csv`] = toCsv(rows);
  }
  return files;
}

function scalar(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toCsv(rows: Record<string, unknown>[]): string {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  const escape = (value: unknown) => {
    let text = scalar(value);
    // Quoting alone does not stop spreadsheet formula evaluation. Preserve numeric amounts.
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return (
    [
      headers.map(escape).join(','),
      ...rows.map((row) => headers.map((key) => escape(row[key])).join(',')),
    ].join('\r\n') + '\r\n'
  );
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value))
    throw new Error('Invalid export identity');
  return value;
}
function label(value: unknown): string {
  return scalar(value)
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\`*_<>[\]]/g, (character) => `\\${character}`);
}

/** Stable ID paths avoid filename collisions, traversal and platform-reserved titles. */
export function exportToMarkdown(data: ExportData): Record<string, string> {
  const files: Record<string, string> = {};
  const folders = new Map(
    (data.folders as Record<string, unknown>[] | undefined)?.map((row) => [
      identity(row.id),
      row,
    ]) ?? [],
  );
  const folderPath = (id: unknown): string => {
    const chain: string[] = [],
      seen = new Set<string>();
    while (typeof id === 'string' && folders.has(id)) {
      if (seen.has(id) || chain.length >= 3) throw new Error('Invalid export folder hierarchy');
      seen.add(id);
      chain.unshift(`folder-${identity(id)}`);
      id = folders.get(id)!.parentId;
    }
    return chain.length ? `${chain.join('/')}/` : '';
  };
  for (const folder of folders.values()) {
    files[`notes/${folderPath(folder.id)}README.md`] = `# ${label(folder.name)}\n`;
  }
  for (const group of groups.filter((name) => name !== 'folders')) {
    for (const row of (data[group] ?? []) as Record<string, unknown>[]) {
      const id = identity(row.id);
      const path =
        group === 'notes' ? `notes/${folderPath(row.folderId)}note-${id}.md` : `${group}/${id}.md`;
      const content =
        group === 'notes' ? row.contentJson : group === 'tasks' ? row.descriptionJson : null;
      const body = content
        ? documentMarkdown(readDocument(content, Number(row.contentSchemaVersion ?? 1)))
        : scalar(row.contentText ?? row.description ?? row.text);
      const title = row.title ?? row.name ?? row.text ?? id;
      const metadata = Object.entries(row).filter(
        ([key]) =>
          !['contentJson', 'descriptionJson', 'contentText', 'text', 'title', 'name'].includes(key),
      );
      files[path] =
        `# ${label(title)}\n\n${body}\n\n## Details\n\n${metadata.map(([key, value]) => `- **${label(key)}:** ${label(value)}`).join('\n')}\n`;
    }
  }
  return files;
}
