-- Supplier interaction and delivery.
--
-- This is where the timeout trap is solved. The supplier contract guarantees
-- that repeating a call with the same request_id returns the same code, so
-- request_id is derived deterministically from (order, supplier) and never from
-- the attempt number. A retry after a timeout therefore doubles as a
-- reconciliation: if the supplier had already issued a code, the retry returns
-- that same code rather than minting a second one.

CREATE TABLE supplier_requests (
    -- req_<order id without prefix>-<supplier>. Stable across every retry.
    request_id    text        PRIMARY KEY,
    order_id      text        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    supplier      text        NOT NULL,

    -- in_flight        intent recorded, outcome not yet known
    -- succeeded        supplier returned a code
    -- failed_definitive supplier explicitly refused, so nothing was issued
    -- unknown          timed out or the connection broke; the supplier MAY have issued
    state         text        NOT NULL CHECK (state IN ('in_flight', 'succeeded', 'failed_definitive', 'unknown')),

    code          text,
    failure_reason text,
    attempts      integer     NOT NULL DEFAULT 0,
    first_sent_at timestamptz NOT NULL DEFAULT now(),
    last_sent_at  timestamptz NOT NULL DEFAULT now(),
    settled_at    timestamptz,

    -- A code and only a code is what "succeeded" means; the two cannot disagree.
    CONSTRAINT supplier_requests_succeeded_has_code
        CHECK ((state = 'succeeded') = (code IS NOT NULL)),

    -- One request per (order, supplier). This is what makes the request_id
    -- derivation safe: the row cannot be duplicated even under concurrency.
    CONSTRAINT supplier_requests_order_supplier_uniq UNIQUE (order_id, supplier)
);

-- Drives the background reconciler that chases indeterminate calls.
CREATE INDEX supplier_requests_unsettled_idx
    ON supplier_requests (last_sent_at)
    WHERE state IN ('in_flight', 'unknown');

-- Every individual HTTP attempt, for observability and for proving in tests that
-- retries reused the same request_id.
CREATE TABLE delivery_attempts (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id   text        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    supplier   text        NOT NULL,
    request_id text        NOT NULL,
    attempt_no integer     NOT NULL,
    outcome    text        NOT NULL CHECK (outcome IN ('issued', 'refused', 'timeout', 'transport_error', 'circuit_open')),
    latency_ms integer,
    error      text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX delivery_attempts_order_idx ON delivery_attempts (order_id, created_at);

-- Deliveries.
--
-- Layer 3 of the exactly-once defence, and the only one that cannot be reasoned
-- around. UNIQUE (order_id) means a second delivery for the same order is
-- rejected by the database itself, no matter how many workers, retries or
-- suppliers raced to produce it.
CREATE TABLE deliveries (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id     text        NOT NULL UNIQUE REFERENCES orders (id) ON DELETE CASCADE,
    supplier     text        NOT NULL,
    request_id   text        NOT NULL REFERENCES supplier_requests (request_id),
    code         text        NOT NULL,
    delivered_at timestamptz NOT NULL DEFAULT now()
);

-- A code may never be handed to two different orders, even across suppliers.
CREATE UNIQUE INDEX deliveries_code_uniq ON deliveries (code);

-- Orphaned issuances.
--
-- The residue of the timeout trap. When supplier A timed out, we failed over to
-- B, and A is later found to have issued a code after all, that code is real
-- stock that was consumed but never sold. It is recorded here rather than
-- discarded, so the money journal still balances and the discrepancy is visible
-- in the reconciliation report.
CREATE TABLE orphan_issuances (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    text        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    supplier    text        NOT NULL,
    request_id  text        NOT NULL UNIQUE REFERENCES supplier_requests (request_id),
    code        text        NOT NULL,
    detected_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    note        text
);

CREATE INDEX orphan_issuances_open_idx ON orphan_issuances (detected_at) WHERE resolved_at IS NULL;
