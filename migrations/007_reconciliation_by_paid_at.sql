-- Index behind the "paid but not delivered" reconciliation query.
--
-- That query used to share orders_open_idx (status, updated_at) with the stuck
-- order sweep, and sharing the column was the bug: the sweep retries an order,
-- the retry writes updated_at = now(), and the report that keys off updated_at
-- loses sight of the very order the sweep is failing to fix. The two questions
-- are different. The sweep asks "has this order stopped moving", which is about
-- updated_at. Reconciliation asks "how long has this customer been waiting for
-- goods they paid for", which is about paid_at and nothing else.
--
-- COALESCE covers the anomaly of a non final order with no paid_at: such a row
-- should surface in the report rather than hide behind a NULL comparison.
CREATE INDEX orders_unfulfilled_idx
    ON orders (COALESCE(paid_at, updated_at))
    WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed');
