-- Order numbers are now looked up in all of weclapp, without a merchant account.
-- Cases that were waiting for an account are searched again once.
INSERT INTO jobs (workspace_id, type, payload, dedupe_key)
SELECT workspace_id, 'case.enrich', jsonb_build_object('conversationId', id::text), 'case.enrich:' || id::text
FROM conversations
WHERE order_match_status = 'no_account'
ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running') DO NOTHING;
