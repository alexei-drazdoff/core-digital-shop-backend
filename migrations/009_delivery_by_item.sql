-- Re-keys the delivery machinery from the order onto the order item.
--
-- Nothing about the guarantees changes here, only what they are guaranteed per.
-- deliveries.order_id UNIQUE said "one code per order"; deliveries.order_item_id
-- UNIQUE says "one code per line", which is the same statement now that a line
-- is the thing being fetched.
--
-- order_id is kept alongside on every table. It is denormalised, but every
-- reconciliation query wants to group by order, and the alternative is a join
-- on the hottest reporting path to recover a column that can never change.

-- ---------------------------------------------------------------------------
-- supplier_requests
-- ---------------------------------------------------------------------------

ALTER TABLE supplier_requests ADD COLUMN order_item_id text REFERENCES order_items (id) ON DELETE CASCADE;

-- The request epoch.
--
-- request_id is derived, never generated, so that a retry after a timeout asks
-- about the SAME request instead of ordering more goods. That is still true. But
-- an untrustworthy supplier introduces a case the first stage did not have: a
-- response that is syntactically fine and semantically wrong (a code already
-- issued to someone else, or a code for the wrong SKU). Repeating a derived
-- request id would fetch that same bad answer forever.
--
-- The epoch is the escape hatch, and it is deliberately narrow: it advances ONLY
-- when a response is rejected as invalid, never on a timeout and never on a
-- refusal. A timeout still re-asks the same question, which is the whole reason
-- the timeout trap is survivable.
ALTER TABLE supplier_requests ADD COLUMN epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0);

UPDATE supplier_requests SET order_item_id = 'itm_' || substr(order_id, 5) WHERE order_item_id IS NULL;
ALTER TABLE supplier_requests ALTER COLUMN order_item_id SET NOT NULL;

-- One live request per (line, supplier, epoch). The derivation of request_id
-- from exactly these three is what makes it safe to rebuild after a crash.
ALTER TABLE supplier_requests DROP CONSTRAINT supplier_requests_order_supplier_uniq;
ALTER TABLE supplier_requests
    ADD CONSTRAINT supplier_requests_item_supplier_epoch_uniq UNIQUE (order_item_id, supplier, epoch);

CREATE INDEX supplier_requests_item_idx ON supplier_requests (order_item_id);

-- ---------------------------------------------------------------------------
-- deliveries
-- ---------------------------------------------------------------------------

ALTER TABLE deliveries ADD COLUMN order_item_id text REFERENCES order_items (id) ON DELETE CASCADE;
UPDATE deliveries SET order_item_id = 'itm_' || substr(order_id, 5) WHERE order_item_id IS NULL;
ALTER TABLE deliveries ALTER COLUMN order_item_id SET NOT NULL;

-- The third and final layer of protection against a double issue, moved onto the
-- line. A second delivery for the same line is refused by the database itself,
-- however many workers, retries or suppliers raced to produce it.
ALTER TABLE deliveries DROP CONSTRAINT deliveries_order_id_key;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_order_item_uniq UNIQUE (order_item_id);

CREATE INDEX deliveries_order_idx ON deliveries (order_id);

-- ---------------------------------------------------------------------------
-- delivery_attempts and orphan_issuances
-- ---------------------------------------------------------------------------

ALTER TABLE delivery_attempts ADD COLUMN order_item_id text REFERENCES order_items (id) ON DELETE CASCADE;
UPDATE delivery_attempts SET order_item_id = 'itm_' || substr(order_id, 5) WHERE order_item_id IS NULL;
ALTER TABLE delivery_attempts ALTER COLUMN order_item_id SET NOT NULL;
CREATE INDEX delivery_attempts_item_idx ON delivery_attempts (order_item_id, created_at);

ALTER TABLE orphan_issuances ADD COLUMN order_item_id text REFERENCES order_items (id) ON DELETE CASCADE;
UPDATE orphan_issuances SET order_item_id = 'itm_' || substr(order_id, 5) WHERE order_item_id IS NULL;
ALTER TABLE orphan_issuances ALTER COLUMN order_item_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- supplier_stub (the TEST DOUBLE, not part of the core)
-- ---------------------------------------------------------------------------

-- The stub records which line a code was issued for as well as which order.
--
-- A real supplier would have no idea what an order item of ours is; it is here
-- only so the tests can ask "how many codes did this LINE consume", which is the
-- exactly-once assertion that actually matters now that a basket makes several
-- calls under one order id.
ALTER TABLE supplier_stub.issuances ADD COLUMN order_item_id text;
UPDATE supplier_stub.issuances SET order_item_id = 'itm_' || substr(order_id, 5) WHERE order_item_id IS NULL;
CREATE INDEX supplier_stub_issuances_item_idx ON supplier_stub.issuances (order_item_id);

-- ---------------------------------------------------------------------------
-- ledger_entries
-- ---------------------------------------------------------------------------

-- Which line a financial fact belongs to. NULL for facts about the basket as a
-- whole: the customer pays once for the order, and the split across lines is
-- decided later by what each supplier managed to do.
ALTER TABLE ledger_entries ADD COLUMN order_item_id text REFERENCES order_items (id) ON DELETE RESTRICT;

UPDATE ledger_entries
   SET order_item_id = 'itm_' || substr(order_id, 5)
 WHERE order_item_id IS NULL
   AND ref_type IN ('delivery', 'orphan_issuance');

-- The refund account.
--
-- Contra-revenue, debit-normal: a refund debits `refund` and credits `psp_cash`,
-- so cash held at the provider drops by exactly what went back while the revenue
-- originally recognised stays on the books next to its reversal. Net revenue is
-- -(revenue + refund), and for a settled order that equals the sum of the
-- delivered lines. That identity IS "оплачено = выдано + возвращено".
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_check CHECK (account IN (
    'psp_cash',         -- money held at the payment provider
    'revenue',          -- what the sale earned
    'refund',           -- what was given back for a line we could not deliver
    'cogs',             -- cost of the code handed over
    'supplier_payable', -- what we owe suppliers
    'shrinkage'         -- stock consumed without a sale (orphaned issuances)
));

CREATE INDEX ledger_entries_item_idx ON ledger_entries (order_item_id) WHERE order_item_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Reconciliation index
-- ---------------------------------------------------------------------------

-- "How long has this customer been waiting for goods they paid for" is now a
-- question about a line, but the clock is still the order's paid_at: the money
-- arrived once, for the whole basket, and nothing the retry loop does to a line
-- should reset it. See 007 for why this is not updated_at.
CREATE INDEX order_items_unfulfilled_idx
    ON order_items (order_id)
    WHERE status IN ('pending', 'delivering', 'out_of_stock', 'delivery_failed');
