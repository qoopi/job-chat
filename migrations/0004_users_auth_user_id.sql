-- Link the chat identity (users) to a Better Auth account. `auth_user_id` is Better Auth's user id
-- (its own tables live separately and are NOT CDC-replicated - epic AC-15). NULL for guests; set on
-- sign-in (adoption stamps it, conversations follow for free). UNIQUE so one auth account maps to one
-- users row - and its btree index IS the findUserByAuthId lookup index (no separate index needed).
-- Postgres UNIQUE permits many NULLs, so every guest row stays valid. Additive + idempotent
-- (ADD COLUMN IF NOT EXISTS skips the column AND its UNIQUE constraint on re-run); applied via
-- `bun run pg:migrate`. NB: 0002/0003 already applied - do not edit them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_user_id TEXT UNIQUE;
