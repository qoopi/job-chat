-- Additive: the description body as SANITIZED HTML (sanitizePostingHtml strips the raw ATS HTML to a STRICT
-- allowlist at ingest - bold/lists/headings/links only; no script/style/iframe/img/svg, no event handlers,
-- no javascript:/data: URLs). Non-nullable String DEFAULT '' so pre-existing snapshot rows and items lacking
-- a description read back as "" (never NULL). IF NOT EXISTS keeps ch:migrate idempotent. This is ADDITIVE:
-- description_text (the plain-text projection) is UNCHANGED - it stays for text consumers and the render
-- fallback. The stored HTML is safe to render trusted BECAUSE it is sanitized at this one ingest home.
ALTER TABLE postings
    ADD COLUMN IF NOT EXISTS description_html String DEFAULT '';
