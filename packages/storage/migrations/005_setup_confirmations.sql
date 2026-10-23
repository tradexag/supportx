-- Steps of the settings checklist that happen outside SupportX (e.g. the mailbox
-- address entered in Seller Central), ticked off by an owner: {"amazon": {"at": "...", "by": "..."}}.
ALTER TABLE workspaces ADD COLUMN setup_confirmations jsonb NOT NULL DEFAULT '{}'::jsonb;
