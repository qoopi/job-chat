-- Index messages.conversation_id: Postgres does NOT auto-index FK columns, so getConversation's
-- `WHERE conversation_id = $1` and messageCounts' `JOIN ... ON cv.id = m.conversation_id` were
-- sequential scans on messages - the two hot seams 004/006 hit every turn. One statement per file
-- (the migration runner applies files in filename order); idempotent, local-only (no CDC/ClickPipe
-- impact). Applied via `bun run pg:migrate`. NB: 0002 is already applied - do not edit it.
CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages (conversation_id);
