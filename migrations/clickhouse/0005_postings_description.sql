-- Additive: the description body (stripped to plain text at ingest by htmlToText) + the department string.
-- Both non-nullable String DEFAULT '' so pre-existing snapshot rows and items lacking a description read
-- back as "" (never NULL). ONE ALTER with two comma-separated actions = a single statement (the HTTP
-- interface rejects multi-statement queries). IF NOT EXISTS per action keeps ch:migrate idempotent. Raw
-- HTML is never stored here - only the plain text projection.
ALTER TABLE postings
    ADD COLUMN IF NOT EXISTS description_text String DEFAULT '',
    ADD COLUMN IF NOT EXISTS department String DEFAULT '';
