-- Catalog and storefront availability.
--
-- The catalog is read constantly and written almost never. Availability is the
-- opposite: it changes on every sale. Keeping them in one table would make a
-- read-mostly table churn on every purchase, so they are split, and the split is
-- arranged so the hot storefront query still needs only one index scan.

CREATE TABLE products (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku          text        NOT NULL UNIQUE,
    name         text        NOT NULL,
    type         text        NOT NULL CHECK (type IN ('topup', 'key', 'subscription', 'giftcard')),
    price_minor  bigint      NOT NULL CHECK (price_minor > 0),

    -- What the code costs us at the supplier. Revenue minus this is the margin,
    -- and it is what the cogs side of the money journal is written against.
    cost_minor   bigint      NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
    currency     char(3)     NOT NULL DEFAULT 'RUB',
    image        text,
    sort_rank    integer     NOT NULL DEFAULT 0,
    is_active    boolean     NOT NULL DEFAULT true,

    -- Denormalised availability flag, NOT a counter.
    --
    -- The exact remaining count changes on every single sale and lives in
    -- product_stock. What the storefront index actually needs is only the
    -- boolean "is there anything left", which flips rarely (on the 0 to
    -- positive and positive to 0 transitions). Putting the rare bit here and
    -- the hot counter elsewhere keeps this table's indexes stable while still
    -- letting "in stock only" be answered by a partial index instead of a join
    -- filter. See docs/EXPLAIN.md.
    in_stock     boolean     NOT NULL DEFAULT false,

    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Storefront, unfiltered. Keyset pagination walks this index backwards and stops
-- after LIMIT rows, so cost does not grow with catalog size or page depth.
CREATE INDEX products_storefront_idx
    ON products (sort_rank DESC, id DESC)
    INCLUDE (sku, type, price_minor, currency)
    WHERE is_active AND in_stock;

-- Storefront filtered by category. Same shape with the category leading.
CREATE INDEX products_storefront_by_type_idx
    ON products (type, sort_rank DESC, id DESC)
    INCLUDE (sku, price_minor, currency)
    WHERE is_active AND in_stock;

-- Admin and reconciliation views need out of stock rows too.
CREATE INDEX products_active_idx ON products (is_active, id);

-- Hot counter, one narrow row per product. Updated inside the same transaction
-- that records a delivery, so the storefront never shows stock that was already
-- sold in a committed transaction.
CREATE TABLE product_stock (
    product_id      bigint      PRIMARY KEY REFERENCES products (id) ON DELETE CASCADE,
    available_count integer     NOT NULL DEFAULT 0 CHECK (available_count >= 0),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
