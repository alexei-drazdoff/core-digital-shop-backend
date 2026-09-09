-- The code registry, and the stub's dishonest modes.
--
-- The second stage's premise is that the supplier's answer cannot be trusted: it
-- may hand back a code it already gave somebody else, a code for the wrong
-- product, or an error for a call that did in fact consume a key. The first
-- stage's defences all assume the supplier is honest but unreliable, which is a
-- different thing entirely — they protect against losing an answer, not against
-- being lied to.
--
-- One table with one primary key answers "один код никогда не уйдёт двум
-- покупателям". Every code the system ever sees is recorded here, in the same
-- transaction as whatever was decided about it, so the question is a lookup
-- rather than a cross check of three tables that could disagree.

CREATE TABLE issued_codes (
    -- The code itself is the key. Not (supplier, code): a code that supplier B
    -- hands back after supplier A already sold it is precisely the case this
    -- exists to catch, and scoping the uniqueness per supplier would miss it.
    code          text        PRIMARY KEY,

    supplier      text        NOT NULL,
    request_id    text        NOT NULL,

    -- Null for a quarantined code: it was never ours to give, so binding it to a
    -- line would assert something untrue.
    order_item_id text        REFERENCES order_items (id) ON DELETE SET NULL,
    order_id      text        REFERENCES orders (id) ON DELETE SET NULL,

    -- delivered   the customer has it
    -- orphan      a key was consumed for a call we could not use; written off as shrinkage
    -- quarantined the supplier offered it and we refused it as invalid
    disposition   text        NOT NULL CHECK (disposition IN ('delivered', 'orphan', 'quarantined')),

    /** Why a quarantined code was refused. Null for the other two. */
    reason        text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX issued_codes_item_idx ON issued_codes (order_item_id);
CREATE INDEX issued_codes_quarantined_idx ON issued_codes (created_at) WHERE disposition = 'quarantined';

-- Backfill from the facts that already exist. Deliveries first, because a
-- delivered code outranks an orphaned one for the same code, which cannot
-- happen but should resolve in the customer's favour if it ever did.
INSERT INTO issued_codes (code, supplier, request_id, order_item_id, order_id, disposition)
SELECT d.code, d.supplier, d.request_id, d.order_item_id, d.order_id, 'delivered'
  FROM deliveries d
ON CONFLICT (code) DO NOTHING;

INSERT INTO issued_codes (code, supplier, request_id, order_item_id, order_id, disposition)
SELECT o.code, o.supplier, o.request_id, o.order_item_id, o.order_id, 'orphan'
  FROM orphan_issuances o
ON CONFLICT (code) DO NOTHING;

-- A rejected response is an attempt like any other, and it belongs in the
-- attempt log next to the timeouts and refusals it has to be distinguished from.
ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_outcome_check;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_outcome_check CHECK (outcome IN (
    'issued',
    'refused',
    'timeout',
    'transport_error',
    'circuit_open',
    -- The supplier answered with something, and the something was wrong.
    'rejected'
));

-- ---------------------------------------------------------------------------
-- supplier_stub (the TEST DOUBLE, not part of the core)
-- ---------------------------------------------------------------------------

-- The stub's own constraints make it structurally honest: supplier_stub_keys_uniq
-- and supplier_stub_issuances_key_uniq mean it CANNOT issue one key twice
-- through its normal path. So the dishonest behaviours deliberately bypass its
-- bookkeeping rather than writing to it, which is also what a real misbehaving
-- supplier looks like from outside: an answer with nothing consistent behind it.
--
-- forced_outcome gains three values:
--   duplicate_code    hands back a code already issued to a different request
--   foreign_code      hands back a code from a different SKU's pool
--   error_after_issue consumes a key, then answers 503
ALTER TABLE supplier_stub.chaos DROP CONSTRAINT chaos_forced_outcome_check;
ALTER TABLE supplier_stub.chaos ADD CONSTRAINT chaos_forced_outcome_check CHECK (forced_outcome IN (
    'ok',
    'error',
    'timeout',
    'out_of_stock',
    'duplicate_code',
    'foreign_code',
    'error_after_issue'
));
