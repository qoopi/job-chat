-- Additive: the per-item apply/careers-site link the jobs-api attaches (externalApplyUrl).
-- Non-nullable String with DEFAULT '' so pre-existing snapshot rows read back as "no link" (empty),
-- never NULL. IF NOT EXISTS keeps ch:migrate idempotent (safe to re-run).
ALTER TABLE postings ADD COLUMN IF NOT EXISTS apply_url String DEFAULT '';
