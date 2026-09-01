-- Background jobs, implemented as a Postgres queue.
--
-- Why not an external broker: enqueuing the delivery job has to be atomic with
-- moving the order to 'paid'. With a broker the enqueue happens outside the
-- database transaction, which opens a window where an order is paid but no job
-- exists (or a job exists for a transaction that rolled back). Keeping the queue
-- in the same database turns that into a single COMMIT, which is the transactional
-- outbox pattern with the relay step removed because producer and consumer share
-- one store.

CREATE TABLE jobs (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind         text        NOT NULL,

    -- Collapses concurrent duplicate enqueues into one live job.
    dedupe_key   text        NOT NULL,

    payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    state        text        NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'dead')),

    run_after    timestamptz NOT NULL DEFAULT now(),
    attempts     integer     NOT NULL DEFAULT 0,
    max_attempts integer     NOT NULL DEFAULT 10,
    locked_at    timestamptz,
    locked_by    text,
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Uniqueness is scoped to live jobs only.
--
-- A global unique key would permanently block re-enqueueing, which would break
-- recovery: an order that ended in out_of_stock must be able to get a fresh
-- delivery job once stock is replenished. Scoping to pending and running gives
-- concurrency-safe deduplication while leaving recovery possible. This is safe
-- precisely because it is not the exactly-once guarantee; deliveries.order_id
-- being UNIQUE is.
CREATE UNIQUE INDEX jobs_live_dedupe_uniq
    ON jobs (dedupe_key)
    WHERE state IN ('pending', 'running');

-- The claim query: ORDER BY run_after, id, FOR UPDATE SKIP LOCKED.
CREATE INDEX jobs_claimable_idx
    ON jobs (run_after, id)
    WHERE state = 'pending';

-- Finds jobs abandoned by a crashed worker.
CREATE INDEX jobs_running_idx ON jobs (locked_at) WHERE state = 'running';

-- HTTP level idempotency for order creation.
--
-- A client that retries POST /orders after a network blip must get the original
-- order back, not a second one it will never see. The stored response is
-- replayed verbatim.
CREATE TABLE idempotency_keys (
    key             text        PRIMARY KEY,
    request_hash    text        NOT NULL,
    response_status integer     NOT NULL,
    response_body   jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
