-- Money journal, double entry.
--
-- Every financial fact is written as a balanced group of entries whose signed
-- amounts sum to zero. The invariant is therefore checkable with one query
-- instead of trusted, which is what "a journal that always balances" has to mean.

CREATE TABLE ledger_entries (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Ties the two or more sides of a single financial fact together.
    group_id     uuid        NOT NULL,
    order_id     text        REFERENCES orders (id) ON DELETE RESTRICT,

    account      text        NOT NULL CHECK (account IN (
                     'psp_cash',         -- money held at the payment provider
                     'revenue',          -- what the sale earned
                     'cogs',             -- cost of the code handed over
                     'supplier_payable', -- what we owe suppliers
                     'shrinkage'         -- stock consumed without a sale (orphaned issuances)
                 )),
    direction    text        NOT NULL CHECK (direction IN ('debit', 'credit')),
    amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
    currency     char(3)     NOT NULL,

    -- Signed projection so balance checks are a plain SUM with no CASE at the
    -- call site. Generated and stored, so it can never drift from direction.
    signed_minor bigint      NOT NULL GENERATED ALWAYS AS
                     (CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) STORED,

    ref_type     text        NOT NULL,
    ref_id       text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),

    -- The same fact must never be journalled twice, which is what makes the
    -- ledger safe to write from an at-least-once job.
    CONSTRAINT ledger_entries_fact_uniq UNIQUE (ref_type, ref_id, account, direction)
);

CREATE INDEX ledger_entries_group_idx ON ledger_entries (group_id);
CREATE INDEX ledger_entries_order_idx ON ledger_entries (order_id, created_at);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account, created_at);
