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
  const [acctName, setAcctName] = useState('');
  const [acctType, setAcctType] = useState<AccountType>('cash');
  const [opening, setOpening] = useState('0');
  const [txnAccount, setTxnAccount] = useState<string | null>(null);
  const [txnType, setTxnType] = useState<TransactionType>('expense');
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [personName, setPersonName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const accounts = records
    .filter((r) => r.type === 'account' && !r.deletedAt)
    .sort((a, b) => a.text.localeCompare(b.text));
  const people = records
    .filter((r) => r.type === 'person' && !r.deletedAt)
    .sort((a, b) => a.text.localeCompare(b.text));
  const transactions = records
    .filter((r) => r.type === 'transaction' && !r.deletedAt)
    .sort((a, b) => (b.transactionDate ?? '').localeCompare(a.transactionDate ?? ''))
    .slice(0, 30);
  const pending = (record: RecordItem) => !record.version || pendingIds.includes(record.id);
  const accountName = (id: string | null) =>
    id ? (accounts.find((a) => a.id === id)?.text ?? 'Account') : '';
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
        merchant: null,
        paymentMethod: null,
        personId: null,
        debtId: null,
        source: 'app',
        splits: [],
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
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    );
    setAmount('');
    setDesc('');
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

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>MONEY</Text>
        <Text style={styles.title}>Track every rupee.</Text>
        <Text style={styles.subtitle}>
          Balances are kept as whole paise and reconciled on the server. Amounts are entered in
          rupees.
        </Text>
        <Button secondary label="Close" disabled={saving} onPress={onClose} />
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}

        <Card>
          <Text style={styles.label}>Accounts</Text>
          {accounts.map((a) => (
            <Text key={a.id} style={styles.subtitle}>
              {a.text} · {money(a.cachedBalanceMinor)}
              {pending(a) ? ' · Sync pending' : ''}
            </Text>
          ))}
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

        <Card>
          <Text style={styles.label}>New transaction</Text>
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
              <Button
                label={saving ? 'Saving…' : 'Add transaction'}
                disabled={saving || !amount.trim()}
                onPress={createTransaction}
              />
            </>
          )}
        </Card>

        <Card>
          <Text style={styles.label}>People</Text>
          {people.map((p) => (
            <Text key={p.id} style={styles.subtitle}>
              {p.text}
            </Text>
          ))}
          <View style={styles.row}>
            <Field
              label="Add person"
              value={personName}
              onChangeText={setPersonName}
              maxLength={200}
            />
            <Button label="Add" disabled={saving || !personName.trim()} onPress={createPerson} />
          </View>
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
      </ScrollView>
    </SafeAreaView>
  );
}
