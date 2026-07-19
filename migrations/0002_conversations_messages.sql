-- conversations + messages: the OLTP chat store (Postgres), source of conversation resume.
-- CDC/ClickPipes replicates by primary key, so every table has a PK (UUID, store- or DB-minted).
-- parts is JSONB and NULL for user messages (only assistant messages carry the insight-card payload);
-- under CDC it lands in ClickHouse as a String - fine, analytics reads posting counts, not parts.
CREATE TABLE IF NOT EXISTS conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT        NOT NULL REFERENCES users (user_id),
    title       TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  UUID        NOT NULL REFERENCES conversations (id),
    role             TEXT        NOT NULL,
    content          TEXT        NOT NULL,
    parts            JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
