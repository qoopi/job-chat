-- Additive: the canonical roles the jobs-api tags each posting with, projected to parallel arrays
-- (role_ids[i] pairs with role_names[i]). Array columns DEFAULT [] so pre-existing snapshot rows and
-- unclassified items read back as "no roles" (empty), never NULL. role_ids drives the role-IN match;
-- both feed the roles dimension the chat resolves a role phrase against. One statement, two ADD COLUMN
-- actions; IF NOT EXISTS keeps ch:migrate idempotent (safe to re-run).
ALTER TABLE postings ADD COLUMN IF NOT EXISTS role_ids Array(Int64) DEFAULT [], ADD COLUMN IF NOT EXISTS role_names Array(String) DEFAULT [];
