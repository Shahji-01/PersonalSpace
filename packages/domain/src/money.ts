import { and, eq, isNull } from 'drizzle-orm';
import {
  people,
  financeAccounts,
  financeCategories,
  debts,
  financeTransactions,
  transactionSplits,
  transactionRevisions,
  type Transaction,
} from '@personalspace/db';
import type { Split } from '@personalspace/validation';
import { DomainError } from './errors';

// --- People ---

export async function personFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(people)
      .where(and(eq(people.id, id), eq(people.userId, userId), isNull(people.deletedAt)))
  )[0];
}

export async function createPerson(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  name: string,
  nickname: string | null,
): Promise<string[]> {
  await tx.insert(people).values({ id, userId, version, name, nickname });
  return [id];
}

export async function updatePerson(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  input: { name?: string; nickname?: string | null; note?: string | null },
): Promise<string[]> {
  const person = await personFor(tx, userId, id);
  if (!person) throw new DomainError('PERSON_NOT_FOUND', 'This person was not found.', 404);
  if (person.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This person changed on another device. Refresh and try again.',
    );
  const patch: Record<string, unknown> = { version, updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.nickname !== undefined) patch.nickname = input.nickname;
  if (input.note !== undefined) patch.note = input.note;
  await tx
    .update(people)
    .set(patch)
    .where(and(eq(people.id, id), eq(people.userId, userId)));
  return [id];
}

// --- Accounts ---

export async function accountFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(financeAccounts)
      .where(
        and(
          eq(financeAccounts.id, id),
          eq(financeAccounts.userId, userId),
          isNull(financeAccounts.deletedAt),
        ),
      )
  )[0];
}

export async function requireAccount(tx: Transaction, userId: string, id: string) {
  const account = await accountFor(tx, userId, id);
  if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', 'This account was not found.', 404);
  return account;
}

export async function createAccount(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  input: {
    name: string;
    accountType: string;
    isLiability: boolean;
    currency: string;
    openingBalanceMinor: number;
    openingDate: string;
  },
): Promise<string[]> {
  await tx.insert(financeAccounts).values({
    id,
    userId,
    version,
    name: input.name,
    accountType: input.accountType,
    isLiability: input.isLiability,
    currency: input.currency,
    openingBalanceMinor: input.openingBalanceMinor,
    openingDate: input.openingDate,
    cachedBalanceMinor: input.openingBalanceMinor,
  });
  return [id];
}

export async function updateAccount(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  input: { name?: string; labelLast4?: string | null },
): Promise<string[]> {
  const account = await requireAccount(tx, userId, id);
  if (account.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This account changed on another device. Refresh and try again.',
    );
  const patch: Record<string, unknown> = { version, updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.labelLast4 !== undefined) patch.labelLast4 = input.labelLast4;
  await tx
    .update(financeAccounts)
    .set(patch)
    .where(and(eq(financeAccounts.id, id), eq(financeAccounts.userId, userId)));
  return [id];
}

// --- Categories ---

export async function categoryFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(financeCategories)
      .where(
        and(
          eq(financeCategories.id, id),
          eq(financeCategories.userId, userId),
          isNull(financeCategories.deletedAt),
        ),
      )
  )[0];
}

export async function createCategory(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  input: {
    kind: string;
    name: string;
    parentId: string | null;
    icon: string | null;
    color: string | null;
  },
): Promise<string[]> {
  if (input.parentId) {
    const parent = await categoryFor(tx, userId, input.parentId);
    if (!parent) throw new DomainError('CATEGORY_NOT_FOUND', 'Parent category was not found.', 404);
    if (parent.parentId)
      throw new DomainError('CATEGORY_TOO_DEEP', 'Categories support only two levels.', 422);
  }
  await tx.insert(financeCategories).values({
    id,
    userId,
    version,
    kind: input.kind,
    name: input.name,
    parentId: input.parentId,
    icon: input.icon,
    color: input.color,
  });
  return [id];
}

export async function updateCategory(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  input: { name?: string; icon?: string | null; color?: string | null },
): Promise<string[]> {
  const cat = await categoryFor(tx, userId, id);
  if (!cat) throw new DomainError('CATEGORY_NOT_FOUND', 'This category was not found.', 404);
  if (cat.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This category changed on another device. Refresh and try again.',
    );
  const patch: Record<string, unknown> = { version, updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.color !== undefined) patch.color = input.color;
  await tx
    .update(financeCategories)
    .set(patch)
    .where(and(eq(financeCategories.id, id), eq(financeCategories.userId, userId)));
  return [id];
}

// --- Transactions ---

export async function transactionFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(financeTransactions)
      .where(and(eq(financeTransactions.id, id), eq(financeTransactions.userId, userId)))
  )[0];
}

/** Validate that splits sum equals the transaction amount. */
function validateSplits(splits: Split[], amountMinor: number) {
  if (splits.length === 0) return;
  const total = splits.reduce((sum, s) => sum + s.amountMinor, 0);
  if (total !== amountMinor)
    throw new DomainError(
      'SPLITS_MISMATCH',
      `Split amounts (${total}) must equal the transaction amount (${amountMinor}).`,
      422,
    );
}

export async function createTransaction(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  input: {
    transactionType: string;
    accountId: string;
    toAccountId: string | null;
    amountMinor: number;
    currency: string;
    toAmountMinor: number | null;
    adjustmentSign: number | null;
    transactionDate: string;
    description: string | null;
    merchant: string | null;
    paymentMethod: string | null;
    personId: string | null;
    debtId: string | null;
    source: string;
    splits: Split[];
  },
): Promise<string[]> {
  // Validate account exists.
  await requireAccount(tx, userId, input.accountId);
  if (input.toAccountId) await requireAccount(tx, userId, input.toAccountId);

  validateSplits(input.splits, input.amountMinor);

  await tx.insert(financeTransactions).values({
    id,
    userId,
    version,
    transactionType: input.transactionType,
    accountId: input.accountId,
    toAccountId: input.toAccountId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    toAmountMinor: input.toAmountMinor,
    adjustmentSign: input.adjustmentSign,
    transactionDate: input.transactionDate,
    description: input.description,
    merchant: input.merchant,
    paymentMethod: input.paymentMethod,
    personId: input.personId,
    debtId: input.debtId,
    source: input.source,
  });

  // Insert splits.
  for (const split of input.splits) {
    await tx.insert(transactionSplits).values({
      id: split.id,
      userId,
      transactionId: id,
      kind: split.kind,
      categoryId: split.categoryId,
      personId: split.personId,
      debtId: split.debtId,
      amountMinor: split.amountMinor,
      note: split.note,
    });
  }

  // Create initial revision.
  await tx.insert(transactionRevisions).values({
    userId,
    transactionId: id,
    snapshot: { ...input, version },
    changedBy: 'user',
    reason: 'created',
  });

  return [id];
}

export async function editTransaction(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  input: {
    amountMinor?: number;
    transactionDate?: string;
    description?: string | null;
    merchant?: string | null;
    paymentMethod?: string | null;
    categoryId?: string | null;
    splits?: Split[];
    reason: string | null;
  },
): Promise<string[]> {
  const txn = await transactionFor(tx, userId, id);
  if (!txn) throw new DomainError('TRANSACTION_NOT_FOUND', 'This transaction was not found.', 404);
  if (txn.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This transaction changed on another device. Refresh and try again.',
    );
  if (txn.status === 'void')
    throw new DomainError('TRANSACTION_VOID', 'Cannot edit a voided transaction.', 422);

  const patch: Record<string, unknown> = { version, updatedAt: new Date() };
  if (input.amountMinor !== undefined) patch.amountMinor = input.amountMinor;
  if (input.transactionDate !== undefined) patch.transactionDate = input.transactionDate;
  if (input.description !== undefined) patch.description = input.description;
  if (input.merchant !== undefined) patch.merchant = input.merchant;
  if (input.paymentMethod !== undefined) patch.paymentMethod = input.paymentMethod;

  await tx
    .update(financeTransactions)
    .set(patch)
    .where(and(eq(financeTransactions.id, id), eq(financeTransactions.userId, userId)));

  // Replace splits if provided.
  if (input.splits) {
    const effectiveAmount = input.amountMinor ?? txn.amountMinor;
    validateSplits(input.splits, effectiveAmount);
    await tx
      .delete(transactionSplits)
      .where(and(eq(transactionSplits.transactionId, id), eq(transactionSplits.userId, userId)));
    for (const split of input.splits) {
      await tx.insert(transactionSplits).values({
        id: split.id,
        userId,
        transactionId: id,
        kind: split.kind,
        categoryId: split.categoryId,
        personId: split.personId,
        debtId: split.debtId,
        amountMinor: split.amountMinor,
        note: split.note,
      });
    }
  }

  // Record revision.
  await tx.insert(transactionRevisions).values({
    userId,
    transactionId: id,
    snapshot: { ...patch, splits: input.splits },
    changedBy: 'user',
    reason: input.reason ?? 'edited',
  });

  return [id];
}

export async function voidTransaction(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  reason: string | null,
): Promise<string[]> {
  const txn = await transactionFor(tx, userId, id);
  if (!txn) throw new DomainError('TRANSACTION_NOT_FOUND', 'This transaction was not found.', 404);
  if (txn.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This transaction changed on another device. Refresh and try again.',
    );
  if (txn.status === 'void')
    throw new DomainError('ALREADY_VOID', 'This transaction is already voided.', 422);

  await tx
    .update(financeTransactions)
    .set({ status: 'void', version, updatedAt: new Date() })
    .where(and(eq(financeTransactions.id, id), eq(financeTransactions.userId, userId)));

  await tx.insert(transactionRevisions).values({
    userId,
    transactionId: id,
    snapshot: { status: 'void' },
    changedBy: 'user',
    reason: reason ?? 'voided',
  });

  return [id];
}

export async function restoreTransaction(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
): Promise<string[]> {
  const txn = await transactionFor(tx, userId, id);
  if (!txn) throw new DomainError('TRANSACTION_NOT_FOUND', 'This transaction was not found.', 404);
  if (txn.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This transaction changed on another device. Refresh and try again.',
    );
  if (txn.status !== 'void')
    throw new DomainError('NOT_VOID', 'This transaction is not voided.', 422);

  await tx
    .update(financeTransactions)
    .set({ status: 'posted', version, updatedAt: new Date() })
    .where(and(eq(financeTransactions.id, id), eq(financeTransactions.userId, userId)));

  await tx.insert(transactionRevisions).values({
    userId,
    transactionId: id,
    snapshot: { status: 'posted' },
    changedBy: 'user',
    reason: 'restored',
  });

  return [id];
}

// --- Debts ---

export async function debtFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(debts)
      .where(and(eq(debts.id, id), eq(debts.userId, userId), isNull(debts.deletedAt)))
  )[0];
}

export async function createDebt(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  input: {
    personId: string;
    direction: string;
    currency: string;
    title: string | null;
    dueOn: string | null;
  },
): Promise<string[]> {
  const person = await personFor(tx, userId, input.personId);
  if (!person) throw new DomainError('PERSON_NOT_FOUND', 'This person was not found.', 404);

  await tx.insert(debts).values({
    id,
    userId,
    version,
    personId: input.personId,
    direction: input.direction,
    currency: input.currency,
    title: input.title,
    openedOn: new Date().toISOString().slice(0, 10),
    dueOn: input.dueOn,
  });
  return [id];
}

export async function setDebtStatus(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  manualStatus: string,
): Promise<string[]> {
  const debt = await debtFor(tx, userId, id);
  if (!debt) throw new DomainError('DEBT_NOT_FOUND', 'This debt was not found.', 404);
  if (debt.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This debt changed on another device. Refresh and try again.',
    );
  await tx
    .update(debts)
    .set({ manualStatus, version, updatedAt: new Date() })
    .where(and(eq(debts.id, id), eq(debts.userId, userId)));
  return [id];
}
