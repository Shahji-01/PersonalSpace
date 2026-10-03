-- Add 'person', 'account', 'category', 'transaction', 'debt' entity types.
ALTER TABLE entities DROP CONSTRAINT entities_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_type_check CHECK(type IN (
  'inbox','note','task','folder','project','reminder',
  'collection','learning_resource',
  'person','account','category','transaction','debt'
));

-- =====================================================================
-- People: lightweight contacts for splits/debts
-- =====================================================================
CREATE TABLE people (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  nickname text CHECK(nickname IS NULL OR length(nickname) <= 100),
  note text CHECK(note IS NULL OR length(note) <= 2000),
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id,user_id),
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE
);
CREATE INDEX people_user ON people(user_id) WHERE deleted_at IS NULL;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE people FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON people TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON people TO personalspace_app;

-- =====================================================================
-- Accounts: cash, bank, wallet, credit card, loan, savings, other
-- =====================================================================
CREATE TABLE finance_accounts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  account_type text NOT NULL CHECK(account_type IN ('cash','bank','wallet','credit_card','loan','savings','other')),
  is_liability boolean NOT NULL DEFAULT false,
  currency char(3) NOT NULL DEFAULT 'INR',
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  opening_date date NOT NULL DEFAULT CURRENT_DATE,
  label_last4 text CHECK(label_last4 IS NULL OR length(label_last4) <= 10),
  sort_order int NOT NULL DEFAULT 0,
  cached_balance_minor bigint NOT NULL DEFAULT 0,
  cached_balance_version bigint NOT NULL DEFAULT 0,
  archived_at timestamptz,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id,user_id),
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE
);
CREATE INDEX finance_accounts_user ON finance_accounts(user_id) WHERE deleted_at IS NULL;
ALTER TABLE finance_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON finance_accounts TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_accounts TO personalspace_app;

-- =====================================================================
-- Categories: two-level (parent -> child), seeded per user at signup
-- =====================================================================
CREATE TABLE finance_categories (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('expense','income')),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  parent_id uuid,
  icon text CHECK(icon IS NULL OR length(icon) <= 50),
  color text CHECK(color IS NULL OR length(color) <= 20),
  is_system_seed boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id,user_id),
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(parent_id,user_id) REFERENCES finance_categories(id,user_id),
  CHECK(parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX finance_categories_user_kind ON finance_categories(user_id, kind) WHERE deleted_at IS NULL;
ALTER TABLE finance_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON finance_categories TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_categories TO personalspace_app;

-- =====================================================================
-- Debts: ledger between user and a person, per currency and direction
-- =====================================================================
CREATE TABLE debts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  person_id uuid NOT NULL,
  direction text NOT NULL CHECK(direction IN ('owed_to_me','i_owe')),
  currency char(3) NOT NULL DEFAULT 'INR',
  title text CHECK(title IS NULL OR length(title) <= 200),
  opened_on date NOT NULL DEFAULT CURRENT_DATE,
  due_on date,
  manual_status text NOT NULL DEFAULT 'open' CHECK(manual_status IN ('open','written_off','cancelled')),
  is_running_ledger boolean NOT NULL DEFAULT true,
  cached_outstanding_minor bigint NOT NULL DEFAULT 0,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id,user_id),
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(person_id,user_id) REFERENCES people(id,user_id)
);
-- One default running ledger per person/direction/currency.
CREATE UNIQUE INDEX debts_running_unique
  ON debts(user_id, person_id, direction, currency)
  WHERE is_running_ledger AND manual_status = 'open' AND deleted_at IS NULL;
CREATE INDEX debts_user_person ON debts(user_id, person_id) WHERE deleted_at IS NULL;
ALTER TABLE debts ENABLE ROW LEVEL SECURITY;
ALTER TABLE debts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON debts TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON debts TO personalspace_app;

-- =====================================================================
-- Transactions: income, expense, transfer, adjustment, lend/borrow, repayments
-- =====================================================================
CREATE TABLE finance_transactions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  transaction_type text NOT NULL CHECK(transaction_type IN (
    'income','expense','transfer','adjustment',
    'lend','borrow','repayment_in','repayment_out'
  )),
  status text NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','pending','void')),
  account_id uuid NOT NULL,
  to_account_id uuid,
  amount_minor bigint NOT NULL CHECK(amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  to_amount_minor bigint,
  adjustment_sign smallint CHECK(adjustment_sign IS NULL OR adjustment_sign IN (-1, 1)),
  transaction_date date NOT NULL DEFAULT CURRENT_DATE,
  occurred_at timestamptz,
  description text CHECK(description IS NULL OR length(description) <= 500),
  merchant text CHECK(merchant IS NULL OR length(merchant) <= 200),
  payment_method text CHECK(payment_method IS NULL OR payment_method IN (
    'upi','card','cash','netbanking','wallet','other'
  )),
  person_id uuid,
  debt_id uuid,
  source text NOT NULL DEFAULT 'app' CHECK(source IN ('app','ai','voice','import','recurring','inbox')),
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id,user_id),
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,user_id) REFERENCES finance_accounts(id,user_id),
  FOREIGN KEY(to_account_id,user_id) REFERENCES finance_accounts(id,user_id),
  FOREIGN KEY(person_id,user_id) REFERENCES people(id,user_id),
  FOREIGN KEY(debt_id,user_id) REFERENCES debts(id,user_id),
  CHECK ((transaction_type = 'transfer') = (to_account_id IS NOT NULL)),
  CHECK (transaction_type <> 'adjustment' OR adjustment_sign IS NOT NULL),
  CHECK (
    transaction_type NOT IN ('lend','borrow','repayment_in','repayment_out')
    OR debt_id IS NOT NULL
  )
);
CREATE INDEX finance_tx_user_date ON finance_transactions(user_id, transaction_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX finance_tx_user_account ON finance_transactions(user_id, account_id, transaction_date)
  WHERE deleted_at IS NULL;
CREATE INDEX finance_tx_user_version ON finance_transactions(user_id, version);
ALTER TABLE finance_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON finance_transactions TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_transactions TO personalspace_app;

-- =====================================================================
-- Transaction splits: category or receivable portions
-- =====================================================================
CREATE TABLE transaction_splits (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('category','receivable')),
  category_id uuid,
  person_id uuid,
  debt_id uuid,
  amount_minor bigint NOT NULL CHECK(amount_minor > 0),
  note text CHECK(note IS NULL OR length(note) <= 500),
  CHECK ((kind = 'category') = (category_id IS NOT NULL)),
  CHECK ((kind = 'receivable') = (debt_id IS NOT NULL AND person_id IS NOT NULL)),
  FOREIGN KEY(transaction_id,user_id) REFERENCES finance_transactions(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(category_id,user_id) REFERENCES finance_categories(id,user_id),
  FOREIGN KEY(person_id,user_id) REFERENCES people(id,user_id),
  FOREIGN KEY(debt_id,user_id) REFERENCES debts(id,user_id)
);
CREATE INDEX transaction_splits_tx ON transaction_splits(transaction_id);
ALTER TABLE transaction_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_splits FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON transaction_splits TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON transaction_splits TO personalspace_app;

-- =====================================================================
-- Transaction revisions: audit trail for money edits
-- =====================================================================
CREATE TABLE transaction_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  changed_by text NOT NULL CHECK(changed_by IN ('user','ai','system')),
  reason text CHECK(reason IS NULL OR length(reason) <= 500),
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(transaction_id,user_id) REFERENCES finance_transactions(id,user_id) ON DELETE CASCADE
);
CREATE INDEX transaction_revisions_tx ON transaction_revisions(transaction_id, created_at DESC);
ALTER TABLE transaction_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON transaction_revisions TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON transaction_revisions TO personalspace_app;
