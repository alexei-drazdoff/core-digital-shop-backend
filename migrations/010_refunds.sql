-- Refunds.
--
-- The assignment's rule is "за что не смогли, деньги возвращаются", and the
-- invariant behind it is "оплачено равно выдано плюс возвращено". Both are only
-- worth something if a refund is a durable fact that can be counted, so it gets
-- a table rather than being implied by a line status plus a ledger entry.
--
-- UNIQUE (order_item_id) is the whole safety story, and it is deliberately the
-- mirror image of deliveries.order_item_id being UNIQUE. One says a line is
-- delivered at most once, the other says it is refunded at most once. Together
-- they make double spending on either side a constraint violation rather than
-- something a reviewer has to trust the retry logic about.

CREATE TABLE refunds (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_item_id text       NOT NULL UNIQUE REFERENCES order_items (id) ON DELETE CASCADE,
    order_id     text        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

    -- The price captured on the line at creation, never today's catalog price.
    -- A refund has to reverse the payment it belongs to, not a later one.
    amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
    currency     char(3)     NOT NULL,

    reason       text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refunds_order_idx ON refunds (order_id);
CREATE INDEX refunds_created_idx ON refunds (created_at);

-- A line cannot be both delivered and refunded.
--
-- This is the one cross-table failure that breaks the money invariant: it would
-- charge the customer for goods and give the money back for the same line, and
-- every per-account sum would still look fine. It cannot be expressed as a table
-- constraint, so the reconciliation report queries for it explicitly and the
-- health verdict fails when it is non-empty. See PgReconciliationRepository.
