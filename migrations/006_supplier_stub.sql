-- Storage for the SUPPLIER STUBS. This is a test double, not part of the core.
--
-- It lives in its own schema so the boundary is visible at a glance: nothing in
-- src/domain, src/application or src/infrastructure ever reads these tables. In
-- production the supplier is a third party with its own datastore and none of
-- this exists. It is persisted rather than kept in memory because the timeout
-- trap has to survive a stub restart to be worth testing.

CREATE SCHEMA IF NOT EXISTS supplier_stub;

-- The key pool. A single key can never be handed to two orders.
CREATE TABLE supplier_stub.keys (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier   text        NOT NULL,
    sku        text        NOT NULL,
    code       text        NOT NULL,
    state      text        NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'issued')),
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT supplier_stub_keys_uniq UNIQUE (supplier, code)
);

CREATE INDEX supplier_stub_keys_available_idx
    ON supplier_stub.keys (supplier, sku, id)
    WHERE state = 'available';

-- Issuances, keyed by request_id.
--
-- This single unique constraint is the whole contract requirement: repeating a
-- call with the same request_id returns the code that was already issued rather
-- than minting a new one. It is what makes a retry after a timeout safe.
CREATE TABLE supplier_stub.issuances (
    request_id text        PRIMARY KEY,
    supplier   text        NOT NULL,
    order_id   text        NOT NULL,
    sku        text        NOT NULL,
    code       text        NOT NULL,
    key_id     bigint      NOT NULL REFERENCES supplier_stub.keys (id),
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT supplier_stub_issuances_key_uniq UNIQUE (key_id)
);

CREATE INDEX supplier_stub_issuances_order_idx ON supplier_stub.issuances (order_id);

-- Failure injection, adjustable at runtime through POST /admin/chaos so the
-- adversarial scenarios are reproducible rather than lucky.
CREATE TABLE supplier_stub.chaos (
    supplier         text    PRIMARY KEY,
    error_rate       numeric NOT NULL DEFAULT 0 CHECK (error_rate BETWEEN 0 AND 1),
    timeout_rate     numeric NOT NULL DEFAULT 0 CHECK (timeout_rate BETWEEN 0 AND 1),
    latency_ms       integer NOT NULL DEFAULT 0,
    hang_ms          integer NOT NULL DEFAULT 30000,

    -- The heart of the timeout trap: when the stub decides to hang, it issues
    -- the code first and only then withholds the response. That is exactly the
    -- real world failure where the supplier did the work and the answer was lost.
    issue_before_hang boolean NOT NULL DEFAULT true,

    -- Hang even for a request id that was already served.
    --
    -- Models a supplier that issued a code and then became entirely unreachable,
    -- rather than one that merely lost a single response. This is the only way an
    -- orphaned issuance can actually form: while the supplier can still answer a
    -- repeat, the caller recovers the code and nothing is wasted.
    hang_before_lookup boolean NOT NULL DEFAULT false,

    -- Overrides the random rates for deterministic tests.
    forced_outcome   text    CHECK (forced_outcome IN ('ok', 'error', 'timeout', 'out_of_stock'))
);
