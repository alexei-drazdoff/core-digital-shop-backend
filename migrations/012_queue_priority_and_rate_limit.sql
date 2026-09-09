-- Priority in the queue, and a rate limit in front of each supplier.
--
-- Task 3's requirements are in tension: do not exceed the supplier's limit, and
-- do not lose anything. Satisfying only the first is trivial (drop the excess),
-- and satisfying only the second is what the queue already did. Together they
-- mean the excess has to WAIT, and waiting has to be free — a job that waits
-- must not be spending the retries it will need if it later actually fails.

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------

-- Higher runs first.
--
-- "Оплаченные заказы обслуживаются раньше неоплаченных" is the requirement, and
-- it only bites when supplier capacity is scarce, which is exactly the burst
-- this migration is for. Fitted with gaps so a kind can be slotted between two
-- existing ones without renumbering everything.
ALTER TABLE jobs ADD COLUMN priority smallint NOT NULL DEFAULT 100;

-- Times this job was put back because a supplier had no capacity to spare.
--
-- Deliberately NOT `attempts`. Attempts measure how many times the work was
-- tried and failed, and a job dies when it runs out of them. A deferral is not a
-- failure — nothing was tried — so counting it as one would mean a big enough
-- burst quietly kills the jobs at the back of the queue, which is precisely the
-- "ничего не теряется" requirement being violated in the least visible way
-- possible. Recorded separately so a pile-up is still observable.
ALTER TABLE jobs ADD COLUMN deferrals integer NOT NULL DEFAULT 0;

-- The claim query is ORDER BY priority DESC, run_after, id, so the index has to
-- lead with priority or every claim becomes a sort of the whole backlog.
DROP INDEX jobs_claimable_idx;
CREATE INDEX jobs_claimable_idx
    ON jobs (priority DESC, run_after, id)
    WHERE state = 'pending';

-- ---------------------------------------------------------------------------
-- supplier_rate_limits
-- ---------------------------------------------------------------------------

-- A token bucket, one row per supplier.
--
-- In the database rather than in the worker, because the limit belongs to the
-- SUPPLIER and workers are horizontally scaled: a per-process limiter would let
-- N workers send N times the agreed rate, which is the failure mode this exists
-- to prevent. One row, one atomic UPDATE, and the count is correct no matter how
-- many workers are running.
--
-- Refill is computed from elapsed time on read rather than by a background
-- ticker. A ticker would have to run somewhere, would drift, and would be one
-- more thing to keep alive; arithmetic on a timestamp cannot fall behind.
CREATE TABLE supplier_rate_limits (
    supplier          text        PRIMARY KEY,

    -- Burst size. Tokens accumulate up to this and no further, so an idle
    -- period cannot be cashed in as one enormous spike at the supplier.
    capacity          integer     NOT NULL CHECK (capacity > 0),

    refill_per_minute integer     NOT NULL CHECK (refill_per_minute > 0),

    -- Fractional on purpose: at 60/minute a token is worth one second, and
    -- integer arithmetic would round every partial second away and slowly
    -- starve the bucket.
    tokens            numeric     NOT NULL CHECK (tokens >= 0),

    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Seeded generously so the limit is inert until somebody configures it. A
-- default that silently throttled a working system would be a bad surprise; the
-- tests and the demo set it down to something small on purpose.
INSERT INTO supplier_rate_limits (supplier, capacity, refill_per_minute, tokens)
VALUES ('supplier_a', 600, 600, 600),
       ('supplier_b', 600, 600, 600)
ON CONFLICT (supplier) DO NOTHING;
