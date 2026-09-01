-- Orders and the payment events that drive them.

CREATE TABLE orders (
    -- ord_<ULID>. ULID is time ordered, so inserts stay at the right edge of the
    -- btree instead of scattering across it the way UUIDv4 does.
    id           text        PRIMARY KEY,
    product_id   bigint      NOT NULL REFERENCES products (id),
    sku          text        NOT NULL,
    amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
    currency     char(3)     NOT NULL,
    customer_ref text,

    status       text        NOT NULL CHECK (status IN (
                     'created',          -- awaiting payment
                     'paid',             -- payment confirmed, delivery pending
                     'delivering',       -- talking to a supplier
                     'delivered',        -- final, code attached
                     'payment_failed',   -- final
                     'out_of_stock',     -- recoverable: paid, no stock yet
                     'delivery_failed'   -- recoverable: both suppliers failed
                 )),

    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    paid_at      timestamptz,
    delivered_at timestamptz
);

-- Drives the "paid but not delivered" reconciliation query and the stuck order
-- recovery scan. Partial, because only non final orders are ever scanned.
CREATE INDEX orders_open_idx
    ON orders (status, updated_at)
    WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed');

CREATE INDEX orders_product_idx ON orders (product_id, created_at DESC);

-- Payment webhook events.
--
-- Layer 1 of the exactly-once defence. The payment provider delivers at least
-- once and out of order, so event_id being the primary key is what makes 50
-- concurrent deliveries of the same event collapse into one:
--   INSERT ... ON CONFLICT (event_id) DO NOTHING RETURNING event_id
-- returns a row in exactly one transaction and nothing in the other 49.
CREATE TABLE payment_events (
    event_id     text        PRIMARY KEY,
    order_id     text        NOT NULL,
    status       text        NOT NULL CHECK (status IN ('paid', 'failed')),
    amount_minor bigint      NOT NULL,
    currency     char(3)     NOT NULL,
    occurred_at  timestamptz NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,

    -- What the event actually did, for the audit trail and the reconciliation report.
    outcome      text        CHECK (outcome IN (
                     'applied',          -- moved the order forward
                     'deferred',         -- arrived before the order existed
                     'ignored_stale',    -- lost the race, another event already moved the order
                     'ignored_terminal', -- order is already in a final state
                     'amount_mismatch'   -- payload disagrees with the order total
                 )),
    payload      jsonb       NOT NULL
);

-- Deferred events are replayed when their order shows up. Partial index keeps
-- the scan proportional to the backlog, not to total payment history.
CREATE INDEX payment_events_deferred_idx
    ON payment_events (order_id)
    WHERE processed_at IS NULL;

CREATE INDEX payment_events_order_idx ON payment_events (order_id, received_at DESC);
