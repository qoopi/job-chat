-- profiles: the signed-in job seeker's structured profile + the raw inputs it was extracted from.
-- Postgres-only by rule (AC-13): the profile shape NEVER enters the ClickHouse path - selection sends
-- derived filter VALUES (title terms, cities), never personal data. One row per user (user_id PK);
-- save = upsert. user_id is TEXT to match users.user_id (the guest-cookie id column, not a uuid).
--
-- Two-phase write. The save ACTION stores the raw inputs (raw_resume_text OR the transient resume_pdf
-- bytes, plus github_username), leaving profile / extracted_at NULL = "extraction pending". The
-- extract-profile TASK then reads the row, extracts, and writes the structured `profile` + `extracted_at`,
-- and NULLs `resume_pdf`. So profile / extracted_at are NULLABLE (a pending row has neither yet - the
-- epic's NOT NULL predated the background-task flow, which needs a pre-extraction row to carry the PDF),
-- and a completed profile is exactly `extracted_at IS NOT NULL` (the poll read waits on that advancing).
--
-- resume_pdf is TRANSIENT PII: written by the save action, read once by the task, NULLed after the
-- extraction TERMINATES (success or permanent failure) - never long-term PII at rest. Additive +
-- idempotent (CREATE TABLE IF NOT EXISTS).
--
-- extraction_failed is the terminal-FAILURE marker: false while pending or done, set true only when the
-- extraction task permanently failed (all retries exhausted). It lets the poll read distinguish "pending"
-- (profile/extracted_at NULL, not failed) from "failed" (this flag) so the saving panel can STOP polling
-- instead of spinning forever. A re-save clears it (a fresh attempt is pending again).
CREATE TABLE IF NOT EXISTS profiles (
    user_id           TEXT        PRIMARY KEY REFERENCES users (user_id),
    raw_resume_text   TEXT,
    resume_pdf        BYTEA,
    github_username   TEXT,
    profile           JSONB,
    extracted_at      TIMESTAMPTZ,
    extraction_failed BOOLEAN     NOT NULL DEFAULT FALSE
);

-- Backfill the column onto a profiles table an earlier run of this (unreleased) migration already
-- created without it (CREATE TABLE IF NOT EXISTS would skip it). Idempotent.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS extraction_failed BOOLEAN NOT NULL DEFAULT FALSE;
