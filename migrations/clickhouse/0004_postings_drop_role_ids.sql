-- Drop the transient role_ids column: an earlier cut of the roles work stored the role id as Int64, but
-- the wire id is a 64-bit integer JSON.parse rounds past the JS safe-integer limit (corrupt on parse), so
-- matching is keyed on role NAME instead and the id column is never populated. IF EXISTS keeps ch:migrate
-- idempotent and makes this a no-op on any DB that never had the column.
ALTER TABLE postings DROP COLUMN IF EXISTS role_ids;
