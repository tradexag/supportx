-- A failing mailbox (e.g. a wrong client secret) is retried with a pause instead of on every scheduler tick.
ALTER TABLE channel_connections ADD COLUMN last_error_at timestamptz;

-- Customer request or information/advertising. Only requests get order matching and a draft.
ALTER TABLE conversations
  ADD COLUMN category text NOT NULL DEFAULT 'support' CHECK (category IN ('support','info')),
  ADD COLUMN category_source text NOT NULL DEFAULT 'auto' CHECK (category_source IN ('auto','rule','person')),
  ADD COLUMN category_reason text;
CREATE INDEX conversations_category ON conversations (workspace_id, category, last_message_at DESC);

-- Operator's sender rules ("mails from this sender are always advertising / always requests").
CREATE TABLE category_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  match_type text NOT NULL CHECK (match_type IN ('from_domain','from_address')),
  pattern text NOT NULL,
  category text NOT NULL CHECK (category IN ('support','info')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, match_type, pattern)
);
