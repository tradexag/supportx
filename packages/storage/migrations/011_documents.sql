-- PDFs a workspace keeps ready to attach to replies (e.g. return instructions).
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/pdf' CHECK (content_type = 'application/pdf'),
  size int NOT NULL CHECK (size > 0),
  sha256 text NOT NULL,
  data bytea NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Removed from the list; kept so a queued reply still sends what was approved.
  deleted_at timestamptz,
  UNIQUE (workspace_id, id)
);
CREATE INDEX documents_workspace ON documents (workspace_id) WHERE deleted_at IS NULL;

-- Chosen attachments belong to the draft version that is approved, and travel with the outbox entry.
ALTER TABLE drafts ADD COLUMN document_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE outbox ADD COLUMN document_ids uuid[] NOT NULL DEFAULT '{}';
