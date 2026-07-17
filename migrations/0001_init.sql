-- users: anonymous cookie session id keys all user state; auth-ready (a provider maps onto user_id later)
CREATE TABLE IF NOT EXISTS users (
    user_id     TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
