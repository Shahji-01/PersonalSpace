import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  commandSchema,
  recordSchema,
  type Command,
  type RecordItem,
  type AccountType,
  type TransactionType,
} from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';
import { newId, type LocalStore } from './store';

const accountTypes: AccountType[] = ['cash', 'bank', 'wallet', 'savings', 'credit_card', 'other'];
const money = (minor: number) => `₹${(minor / 100).toFixed(2)}`;
const toMinor = (rupees: string): number | null => {
  const n = Number(rupees);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
};

type MoneyTab = 'accounts' | 'transactions' | 'categories' | 'debts' | 'people';

export function MoneyScreen({
  records,
  pendingIds,
  store,
  onClose,
  onChanged,
}: {
  records: RecordItem[];
  pendingIds: string[];
  store: LocalStore;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [tab, setTab] = useState<MoneyTab>('accounts');
  const [acctName, setAcctName] = useState('');
  const [acctType, setAcctType] = useState<AccountType>('cash');
  const [opening, setOpening] = useState('0');
  const [txnAccount, setTxnAccount] = useState<string | null>(null);
  const [txnType, setTxnType] = useState<TransactionType>('expense');
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [merchant, setMerchant] = useState('');
  const [txnCategoryId, setTxnCategoryId] = useState<string | null>(null);
  const [personName, setPersonName] = useState('');
  const [catName, setCatName] = useState('');
  const [catKind, setCatKind] = useState<'expense' | 'income'>('expense');
  const [debtPersonId, setDebtPersonId] = useState<string | null>(null);
  const [debtDirection, setDebtDirection] = useState<'owed_to_me' | 'i_owe'>('i_owe');
  const [debtTitle, setDebtTitle] = useState('');
  const [debtDue, setDebtDue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const accounts = records
    .filter((r) => r.type === 'account' && !r.deletedAt)
    .sort((a, b) => a.text.localeCompare(b.text));
  const people = records
    .filter((r) => r.type === 'person' && !r.deletedAt)
    .sort((a, b) => a.text.localeCompare(b.text));
  const categories = records
    .filter((r) => r.type === 'category' && !r.deletedAt)
    .sort((a, b) => a.text.localeCompare(b.text));
  const transactions = records
    .filter((r) => r.type === 'transaction' && !r.deletedAt)
    .sort((a, b) => (b.transactionDate ?? '').localeCompare(a.transactionDate ?? ''))
    .slice(0, 50);
  const debts = records
    .filter((r) => r.type === 'debt' && !r.deletedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const pending = (record: RecordItem) => !record.version || pendingIds.includes(record.id);
  const accountName = (id: string | null) =>
    id ? (accounts.find((a) => a.id === id)?.text ?? 'Account') : '';
  const personNameOf = (id: string | null) =>
    id ? (people.find((p) => p.id === id)?.text ?? 'Person') : '';
  const categoryNameOf = (id: string | null) =>
    id ? (categories.find((c) => c.id === id)?.text ?? 'Category') : '';
  const selectedAccount = txnAccount ?? accounts[0]?.id ?? null;

  async function enqueue(command: Command, optimistic?: RecordItem, previous?: RecordItem) {
    if (saving) return;
    const parsed = commandSchema.safeParse(command);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the details.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await store.enqueue({ mutationId: newId(), command: parsed.data }, optimistic, previous);
      await onChanged();
    } catch {
      setError('Could not save. Wait for pending changes to sync and try again.');
    } finally {
      setSaving(false);
    }
  }

  function createAccount() {
    const id = newId();
    const now = new Date().toISOString();
    const openingBalanceMinor = Math.round((Number(opening) || 0) * 100);
    void enqueue(
      {
        op: 'account.create',
        id,
        name: acctName.trim(),
        accountType: acctType,
        isLiability: false,
        currency: 'INR',
        openingBalanceMinor,
        openingDate: today,
      },
      recordSchema.parse({
        id,
        type: 'account',
        text: acctName.trim(),
        status: 'active',
        accountType: acctType,
        currency: 'INR',
        openingBalanceMinor,
        cachedBalanceMinor: openingBalanceMinor,
        openingDate: today,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    );
    setAcctName('');
    setOpening('0');
  }

  function createTransaction() {
    if (!selectedAccount) {
      setError('Create an account first.');
      return;
    }
    const amountMinor = toMinor(amount);
    if (!amountMinor) {
      setError('Enter an amount greater than zero.');
      return;
    }
    const id = newId();
    const now = new Date().toISOString();
    // Build splits array if a category is selected
    const splits = txnCategoryId
      ? [{ id: newId(), kind: 'category' as const, categoryId: txnCategoryId, personId: null, debtId: null, amountMinor, note: null }]
      : [];
    void enqueue(
      {
        op: 'transaction.create',
        id,
        transactionType: txnType,
        accountId: selectedAccount,
        toAccountId: null,
        amountMinor,
        currency: 'INR',
        toAmountMinor: null,
        adjustmentSign: null,
        transactionDate: today,
        description: desc.trim() || null,
        merchant: merchant.trim() || null,
        paymentMethod: null,
        personId: null,
        debtId: null,
        source: 'app',
        splits,
      },
      recordSchema.parse({
        id,
        type: 'transaction',
        text: desc.trim() || (txnType === 'income' ? 'Income' : 'Expense'),
        status: 'posted',
        transactionType: txnType,
        transactionStatus: 'posted',
        accountId: selectedAccount,
        amountMinor,
        currency: 'INR',
        transactionDate: today,
        description: desc.trim() || null,
        merchant: merchant.trim() || null,
        splits,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    );
    setAmount('');
    setDesc('');
    setMerchant('');
    setTxnCategoryId(null);
  }

  function createPerson() {
    const id = newId();
    const now = new Date().toISOString();
    void enqueue(
      { op: 'person.create', id, name: personName.trim(), nickname: null },
      recordSchema.parse({
        id,
        type: 'person',
        text: personName.trim(),
        status: 'active',
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    );
    setPersonName('');
  }

  function createCategory() {
    const id = newId();
    const now = new Date().toISOString();
    void enqueue(
      {
        op: 'category.create',
        id,
        kind: catKind,
        name: catName.trim(),
        parentId: null,
        icon: null,
        color: null,
      },
      recordSchema.parse({
        id,
        type: 'category',
        text: catName.trim(),
        status: 'active',
        categoryKind: catKind,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    );
    setCatName('');
  }

  function createDebt() {
    if (!debtPersonId) {
      setError('Select a person first.');
      return;
    }
    const id = newId();
    const now = new Date().toISOString();
    void enqueue(
      {
        op: 'debt.create',
        id,
        personId: debtPersonId,
        direction: debtDirection,
        currency: 'INR',
        title: debtTitle.trim() || null,
        dueOn: debtDue || null,
      },
      recordSchema.parse({
        id,
        type: 'debt',
        text: debtTitle.trim() || (debtDirection === 'i_owe' ? 'I owe' : 'Owed to me'),
        status: 'open',
        debtDirection,
        debtTitle: debtTitle.trim() || null,
        dueOn: debtDue || null,
        currency: 'INR',
        personId: debtPersonId,
        cachedOutstandingMinor: 0,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    );
    setDebtTitle('');
    setDebtDue('');
  }

  const tabs: { key: MoneyTab; label: string }[] = [
    { key: 'accounts', label: 'Accounts' },
    { key: 'transactions', label: 'Txns' },
    { key: 'categories', label: 'Categories' },
    { key: 'debts', label: 'Debts' },
    { key: 'people', label: 'People' },
  ];

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>MONEY</Text>
        <Text style={styles.title}>Track every rupee.</Text>
        <Button secondary label="Close" disabled={saving} onPress={onClose} />
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}

        <View style={styles.row}>
          {tabs.map((t) => (
            <Button
              key={t.key}
              secondary={tab !== t.key}
              label={t.label}
              onPress={() => setTab(t.key)}
            />
          ))}
        </View>

        {/* ==================== ACCOUNTS TAB ==================== */}
        {tab === 'accounts' && (
          <>
            <Card>
              <Text style={styles.label}>Your Accounts</Text>
              {!accounts.length && <Text style={styles.subtitle}>No accounts yet.</Text>}
              {accounts.map((a) => (
                <View key={a.id} style={[styles.row, { justifyContent: 'space-between' }]}>
                  <Text style={styles.subtitle}>
                    {a.text} · {a.accountType} · {money(a.cachedBalanceMinor)}
                  </Text>
                  {pending(a) && <Text style={styles.subtitle}>Syncing…</Text>}
                </View>
              ))}
            </Card>
            <Card>
              <Text style={styles.label}>Add Account</Text>
              <Field label="Account name" value={acctName} onChangeText={setAcctName} maxLength={200} />
              <View style={styles.row}>
                {accountTypes.map((t) => (
                  <Button key={t} secondary={acctType !== t} label={t} onPress={() => setAcctType(t)} />
                ))}
              </View>
              <Field
                label="Opening balance (₹)"
                value={opening}
                onChangeText={setOpening}
                keyboardType="numeric"
              />
              <Button
                label="Add account"
                disabled={saving || !acctName.trim()}
                onPress={createAccount}
              />
            </Card>
          </>
        )}

        {/* ==================== TRANSACTIONS TAB ==================== */}
        {tab === 'transactions' && (
          <>
            <Card>
              <Text style={styles.label}>New Transaction</Text>
              {!accounts.length && <Text style={styles.subtitle}>Add an account first.</Text>}
              {accounts.length > 0 && (
                <>
                  <View style={styles.row}>
                    {accounts.map((a) => (
                      <Button
                        key={a.id}
                        secondary={selectedAccount !== a.id}
                        label={a.text}
                        onPress={() => setTxnAccount(a.id)}
                      />
                    ))}
                  </View>
                  <View style={styles.row}>
                    <Button
                      secondary={txnType !== 'expense'}
                      label="Expense"
                      onPress={() => setTxnType('expense')}
                    />
                    <Button
                      secondary={txnType !== 'income'}
                      label="Income"
                      onPress={() => setTxnType('income')}
                    />
                  </View>
                  <Field
                    label="Amount (₹)"
                    value={amount}
                    onChangeText={setAmount}
                    keyboardType="numeric"
                  />
                  <Field label="Description" value={desc} onChangeText={setDesc} maxLength={500} />
                  <Field label="Merchant (optional)" value={merchant} onChangeText={setMerchant} maxLength={200} />
                  {categories.length > 0 && (
                    <>
                      <Text style={styles.label}>Category (optional)</Text>
                      <View style={styles.row}>
                        <Button
                          secondary={txnCategoryId !== null}
                          label="None"
                          onPress={() => setTxnCategoryId(null)}
                        />
                        {categories
                          .filter((c) => c.categoryKind === txnType || !c.categoryKind)
                          .map((c) => (
                            <Button
                              key={c.id}
                              secondary={txnCategoryId !== c.id}
                              label={c.text}
                              onPress={() => setTxnCategoryId(c.id)}
                            />
                          ))}
                      </View>
                    </>
                  )}
                  <Button
                    label={saving ? 'Saving…' : 'Add transaction'}
                    disabled={saving || !amount.trim()}
                    onPress={createTransaction}
                  />
                </>
              )}
            </Card>

            {!transactions.length && <Text style={styles.subtitle}>No transactions yet.</Text>}
            {transactions.map((t) => (
              <Card key={t.id}>
                <Text style={styles.label}>
                  {t.transactionType === 'income' ? '+' : '−'}
                  {money(t.amountMinor)} · {t.text}
                </Text>
                <Text style={styles.subtitle}>
                  {t.transactionDate} · {accountName(t.accountId)}
                  {t.merchant ? ` · ${t.merchant}` : ''}
                  {t.splits?.length ? ` · ${t.splits.map((s: any) => categoryNameOf(s.categoryId)).filter(Boolean).join(', ')}` : ''}
                  {t.transactionStatus === 'void' ? ' · VOID' : ''}
                  {pending(t) ? ' · Sync pending' : ''}
                </Text>
                {t.transactionStatus !== 'void' && (
                  <Button
                    secondary
                    label="Void"
                    disabled={saving || pending(t)}
                    onPress={() =>
                      void enqueue(
                        { op: 'transaction.void', id: t.id, reason: null, baseVersion: t.version },
                        { ...t, status: 'void', transactionStatus: 'void' },
                        t,
                      )
                    }
                  />
                )}
              </Card>
            ))}
          </>
        )}

        {/* ==================== CATEGORIES TAB ==================== */}
        {tab === 'categories' && (
          <>
            <Card>
              <Text style={styles.label}>Add Category</Text>
              <Field label="Category name" value={catName} onChangeText={setCatName} maxLength={100} />
              <View style={styles.row}>
                <Button
                  secondary={catKind !== 'expense'}
                  label="Expense"
                  onPress={() => setCatKind('expense')}
                />
                <Button
                  secondary={catKind !== 'income'}
                  label="Income"
                  onPress={() => setCatKind('income')}
                />
              </View>
              <Button
                label="Add category"
                disabled={saving || !catName.trim()}
                onPress={createCategory}
              />
            </Card>

            {!categories.length && <Text style={styles.subtitle}>No categories yet.</Text>}
            {categories.map((c) => (
              <Card key={c.id}>
                <View style={[styles.row, { justifyContent: 'space-between' }]}>
                  <Text style={styles.label}>
                    {c.text} · {c.categoryKind ?? 'expense'}
                  </Text>
                  <Button
                    secondary
                    label="Delete"
                    disabled={saving || pending(c)}
                    onPress={() =>
                      void enqueue(
                        { op: 'category.delete', id: c.id, baseVersion: c.version },
                        { ...c, deletedAt: new Date().toISOString() },
                        c,
                      )
                    }
                  />
                </View>
              </Card>
            ))}
          </>
        )}

        {/* ==================== DEBTS TAB ==================== */}
        {tab === 'debts' && (
          <>
            <Card>
              <Text style={styles.label}>Track a Debt</Text>
              {!people.length && (
                <Text style={styles.subtitle}>Add a person in the People tab first.</Text>
              )}
              {people.length > 0 && (
                <>
                  <Text style={styles.label}>Who?</Text>
                  <View style={styles.row}>
                    {people.map((p) => (
                      <Button
                        key={p.id}
                        secondary={debtPersonId !== p.id}
                        label={p.text}
                        onPress={() => setDebtPersonId(p.id)}
                      />
                    ))}
                  </View>
                  <View style={styles.row}>
                    <Button
                      secondary={debtDirection !== 'i_owe'}
                      label="I owe them"
                      onPress={() => setDebtDirection('i_owe')}
                    />
                    <Button
                      secondary={debtDirection !== 'owed_to_me'}
                      label="They owe me"
                      onPress={() => setDebtDirection('owed_to_me')}
                    />
                  </View>
                  <Field label="Title (optional)" value={debtTitle} onChangeText={setDebtTitle} maxLength={200} />
                  <Field
                    label="Due date (YYYY-MM-DD, optional)"
                    value={debtDue}
                    onChangeText={setDebtDue}
                    autoCapitalize="none"
                  />
                  <Button
                    label={saving ? 'Saving…' : 'Create debt'}
                    disabled={saving || !debtPersonId}
                    onPress={createDebt}
                  />
                </>
              )}
            </Card>

            {!debts.length && <Text style={styles.subtitle}>No debts tracked yet.</Text>}
            {debts.map((d) => (
              <Card key={d.id}>
                <Text style={styles.label}>
                  {d.debtDirection === 'i_owe' ? '↑ I owe' : '↓ Owed to me'} · {personNameOf(d.personId)}
                </Text>
                <Text style={styles.subtitle}>
                  {d.debtTitle || 'Debt'}
                  {d.dueOn ? ` · Due ${d.dueOn}` : ''}
                  {d.cachedOutstandingMinor ? ` · ${money(d.cachedOutstandingMinor)} outstanding` : ''}
                  {' · '}
                  {d.status}
                  {pending(d) ? ' · Sync pending' : ''}
                </Text>
                <View style={styles.row}>
                  {d.status === 'open' && (
                    <>
                      <Button
                        secondary
                        label="Write off"
                        disabled={saving || pending(d)}
                        onPress={() =>
                          void enqueue(
                            { op: 'debt.writeOff', id: d.id, baseVersion: d.version },
                            { ...d, status: 'written_off' },
                            d,
                          )
                        }
                      />
                      <Button
                        secondary
                        label="Cancel"
                        disabled={saving || pending(d)}
                        onPress={() =>
                          void enqueue(
                            { op: 'debt.cancel', id: d.id, baseVersion: d.version },
                            { ...d, status: 'cancelled' },
                            d,
                          )
                        }
                      />
                    </>
                  )}
                </View>
              </Card>
            ))}
          </>
        )}

        {/* ==================== PEOPLE TAB ==================== */}
        {tab === 'people' && (
          <>
            <Card>
              <Text style={styles.label}>Add Person</Text>
              <View style={styles.row}>
                <Field
                  label="Name"
                  value={personName}
                  onChangeText={setPersonName}
                  maxLength={200}
                />
                <Button label="Add" disabled={saving || !personName.trim()} onPress={createPerson} />
              </View>
            </Card>

            {!people.length && <Text style={styles.subtitle}>No people added yet.</Text>}
            {people.map((p) => (
              <Card key={p.id}>
                <Text style={styles.label}>{p.text}</Text>
                {p.nickname && <Text style={styles.subtitle}>aka {p.nickname}</Text>}
                {pending(p) && <Text style={styles.subtitle}>Sync pending</Text>}
              </Card>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
