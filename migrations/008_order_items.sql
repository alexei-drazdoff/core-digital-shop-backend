-- Order items: the unit of fulfilment moves from the order to the line.
--
-- In the first stage an order was one product from one supplier, so "the order"
-- and "the thing a supplier delivers" were the same row and could share a key.
-- A basket breaks that: three products from three suppliers succeed or fail
-- independently, and the customer keeps what arrived while the rest is refunded.
--
-- Everything that guarded delivery stays exactly as it was, only re-keyed onto
-- the line. That is deliberate. The three layers of protection against a double
-- issue, the derived request id and the transactional outbox were not properties
-- of the order; they were properties of "one thing being fetched once", and the
-- line is now that thing.
--
-- There is no single-item fast path. Two code paths would mean two sets of money
-- arithmetic, and the invariant paid = delivered + refunded would stop being
-- provable with one query.

CREATE TABLE order_items (
    -- itm_<ULID>, same reasoning as the order id: time ordered, so inserts land
    -- at the right edge of the btree.
    id            text        PRIMARY KEY,
    order_id      text        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

    -- Position in the basket. Stable, so a client can talk about "line 2" and
    -- so (order_id, line_no) gives the line a natural second identity.
    line_no       integer     NOT NULL CHECK (line_no > 0),

    product_id    bigint      NOT NULL REFERENCES products (id),
    sku           text        NOT NULL,

    -- Price and cost are copied at creation rather than read through products.
    -- The catalog changes; what the customer paid for this line does not, and a
    -- refund computed from today's price would not match yesterday's payment.
    price_minor   bigint      NOT NULL CHECK (price_minor > 0),
    cost_minor    bigint      NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
    currency      char(3)     NOT NULL,

    -- Deliberately mirrors the order statuses from 002_orders.sql minus the
    -- payment ones, which belong to the order as a whole. A reviewer who has
    -- read the order state machine already knows this one.
    status        text        NOT NULL DEFAULT 'pending' CHECK (status IN (
                      'pending',          -- awaiting its turn at a supplier
                      'delivering',       -- a worker is talking to a supplier
                      'delivered',        -- final, code attached
                      'out_of_stock',     -- recoverable: no key at any supplier
                      'delivery_failed',  -- recoverable: suppliers unwell
                      'refunded'          -- final, money returned
                  )),

    -- Completed delivery rounds. A round is one pass through every supplier, not
    -- one HTTP attempt. Bounded, because "за что не смогли, деньги возвращаются"
    -- is only true if the trying eventually stops.
    rounds        integer     NOT NULL DEFAULT 0,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    delivered_at  timestamptz,
    refunded_at   timestamptz,

    CONSTRAINT order_items_line_uniq UNIQUE (order_id, line_no)
);

CREATE INDEX order_items_order_idx ON order_items (order_id, line_no);

-- Drives the per-item stuck sweep. Partial, because only unresolved lines are
-- ever scanned and those are a tiny fraction of history.
CREATE INDEX order_items_open_idx
    ON order_items (status, updated_at)
    WHERE status IN ('pending', 'delivering', 'out_of_stock', 'delivery_failed');

-- Existing orders become one-line orders.
--
-- The id is derived from the order id rather than generated, so re-running this
-- migration on a restored dump produces the same keys and any foreign key that
-- was written against a line still points at it.
INSERT INTO order_items (id, order_id, line_no, product_id, sku, price_minor, cost_minor, currency, status,
                         created_at, updated_at, delivered_at)
SELECT 'itm_' || substr(o.id, 5),
       o.id,
       1,
       o.product_id,
       o.sku,
       o.amount_minor,
       COALESCE(p.cost_minor, 0),
       o.currency,
       CASE o.status
           WHEN 'delivered'       THEN 'delivered'
           WHEN 'delivering'      THEN 'delivering'
           WHEN 'out_of_stock'    THEN 'out_of_stock'
           WHEN 'delivery_failed' THEN 'delivery_failed'
           -- created / paid / payment_failed are states of the money, not of the
           -- line. The line has simply not been attempted yet.
           ELSE 'pending'
       END,
       o.created_at,
       o.updated_at,
       o.delivered_at
  FROM orders o
  JOIN products p ON p.id = o.product_id;

-- The order keeps the money and loses the goods.
--
-- product_id and sku described the single thing being bought and have no meaning
-- for a basket. amount_minor stays and becomes the sum of the lines, which is
-- what the payment webhook already compares its payload against, so that check
-- survives this migration untouched.
DROP INDEX orders_product_idx;
ALTER TABLE orders DROP COLUMN product_id;
ALTER TABLE orders DROP COLUMN sku;

-- Two new terminal states for the order.
--
-- partially_delivered is the honest answer the assignment asks for: some lines
-- were handed over, the rest were refunded, and the order is finished. Calling
-- that either "delivered" or "failed" would misreport what the customer got.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
    'created',
    'paid',
    'delivering',
    'delivered',            -- final: every line delivered
    'partially_delivered',  -- final: some lines delivered, the rest refunded
    'refunded',             -- final: nothing could be delivered, all money back
    'payment_failed',
    'out_of_stock',
    'delivery_failed'
));
