-- Append-only history, and the triggers that make "append-only" true.
--
-- Task 4 asks that the exact state of an order and of the money at any past
-- moment be recoverable, that history is only ever added to, and that period
-- totals come out of it and add up.
--
-- The second of those is the one that is usually claimed and rarely enforced. A
-- table nobody happens to UPDATE is not an append-only log; it is a table that
-- has been lucky. The trigger below turns the claim into a property of the
-- database, so it survives the next person who has a very good reason to fix one
-- row by hand.

CREATE TABLE order_events (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id      text        NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
    /** Null for facts about the whole basket, like the payment. */
    order_item_id text        REFERENCES order_items (id) ON DELETE RESTRICT,

    type          text        NOT NULL,
    payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Two timestamps, because they answer different questions and confusing them
    -- is what makes an "as of" query wrong.
    --
    -- occurred_at is when the fact happened in the world: when the payment
    -- provider says the money moved, which may be before we heard about it.
    --
    -- recorded_at is when WE learned it. A reconstruction of "what did we
    -- believe at 12:00" must fold on recorded_at, because a webhook that arrived
    -- at 12:05 about an event at 11:55 was not something we knew at 12:00. Using
    -- occurred_at would produce a history that retroactively knew the future,
    -- which is exactly what "задним числом ничего не переписывается" forbids.
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- The as-of fold: every event for one order up to a moment, in order.
CREATE INDEX order_events_order_idx ON order_events (order_id, recorded_at, id);

-- Period reports scan by time across all orders.
CREATE INDEX order_events_recorded_idx ON order_events (recorded_at);

CREATE INDEX order_events_item_idx ON order_events (order_item_id) WHERE order_item_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
        USING HINT = 'Record a new, correcting fact instead of altering a recorded one.';
END;
$$ LANGUAGE plpgsql;

-- The history of what happened.
CREATE TRIGGER order_events_append_only
    BEFORE UPDATE OR DELETE ON order_events
    FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- The history of the money.
--
-- The ledger was already append-only by convention: every writer only ever
-- INSERTs, and a correction is a new balanced group rather than an edit. The
-- convention is now a constraint, which matters more here than anywhere else —
-- a journal that can be quietly adjusted is not a journal, and every "the money
-- adds up" claim in this project rests on these rows never having been touched.
CREATE TRIGGER ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
