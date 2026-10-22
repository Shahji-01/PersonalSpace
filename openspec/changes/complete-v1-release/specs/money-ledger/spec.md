## Purpose

Make recorded money movements, balances, debts and reports internally consistent and fully usable without performing external financial transactions.

## ADDED Requirements

### Requirement: Balances reflect every committed ledger change

Account balances SHALL equal opening balance plus active transaction effects under the product's integer-money rules. Create, edit, void and restore SHALL update affected account balances atomically and publish their new versions for sync. Duplicate mutations SHALL have no additional effect.

#### Scenario: Expense committed and replayed

- **WHEN** an expense is committed and its original mutation is retried
- **THEN** the balance decreases once and the account screen, Today and reports converge to the same value

#### Scenario: Transfer is voided

- **WHEN** a transfer is voided
- **THEN** both affected account effects are reversed atomically and the transfer is not counted as spending or income

### Requirement: Splits and debt effects remain valid

Money operations SHALL enforce ownership, supported currency and amount rules, valid split totals and the debt/share semantics in specification section 45. Amount edits SHALL revalidate existing splits even when no replacement split list is submitted. Debt payments and status changes SHALL preserve the outstanding-balance invariants.

#### Scenario: Edit amount without matching splits

- **WHEN** a transaction amount changes while retained splits no longer sum to it
- **THEN** the operation is rejected atomically with an actionable validation error

#### Scenario: Shared expense repaid

- **WHEN** a recorded repayment settles a shared-expense receivable
- **THEN** outstanding debt decreases by the valid amount without counting the repayment as a second expense

### Requirement: Mobile supports all v1 money workflows

Users SHALL create and maintain accounts, categories and people; record income, expense, transfer, adjustment, lending, borrowing and repayment; allocate category/person splits; and inspect/edit/void/restore transaction revisions. Forms SHALL show currency and exact minor-unit amounts with explicit confirmation and recoverable errors.

#### Scenario: Multi-split expense saved offline

- **WHEN** a user confirms a valid expense with category and person splits offline
- **THEN** it appears once as pending with recoverable input, and replay preserves its allocation and debt effects

#### Scenario: Validation fails after reconnect

- **WHEN** a pending transaction references an account or person that is no longer valid
- **THEN** the user can correct the retained transaction without a false successful balance change

### Requirement: Reports use canonical financial semantics

Monthly totals, category/person summaries, account balances, debt outstanding and CSV export SHALL agree with the canonical ledger for the same filters. Void entries and transfers SHALL follow section 45, and mixed currencies SHALL not be silently summed without supported conversion.

#### Scenario: Report and export compared

- **WHEN** the same account/date filters are used for a monthly report and export
- **THEN** integer totals reconcile exactly, including edited and voided transactions

### Requirement: Existing balance drift is repaired transparently

Reconciliation SHALL detect and alert on drift without silently overwriting balances. A separately authorized repair operation SHALL calculate from canonical records, be idempotent, record an audit event and publish changed balances to clients.

#### Scenario: Historical cached balance is stale

- **WHEN** reconciliation detects a discrepancy
- **THEN** it records a content-minimized alert; an audited repair can correct the cache without creating a money transaction or losing history
