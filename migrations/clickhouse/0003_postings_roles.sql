-- Additive: the canonical role NAMES the jobs-api tags each posting with. Array(String) DEFAULT [] so
-- pre-existing snapshot rows and unclassified items read back as "no roles" (empty), never NULL. Names
-- are the matching key - the wire role id is a 64-bit integer JSON.parse rounds past the JS safe-integer
-- limit, so it is never stored. IF NOT EXISTS keeps ch:migrate idempotent (safe to re-run).
ALTER TABLE postings ADD COLUMN IF NOT EXISTS role_names Array(String) DEFAULT [];
