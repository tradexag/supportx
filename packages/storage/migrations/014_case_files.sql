-- Files that belong to one case only: a file uploaded for one reply, or an invoice
-- document fetched from the ERP. They do not show in the workspace document list.
ALTER TABLE documents ADD COLUMN conversation_id uuid;
ALTER TABLE documents ADD CONSTRAINT documents_conversation_fk
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN source text NOT NULL DEFAULT 'library' CHECK (source IN ('library', 'upload', 'erp_invoice'));
-- ERP record the file was fetched from (e.g. the weclapp invoice id).
ALTER TABLE documents ADD COLUMN external_ref text;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_content_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_content_type_check CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png'));
ALTER TABLE documents ADD CONSTRAINT documents_case_scope CHECK ((source = 'library') = (conversation_id IS NULL));
CREATE INDEX documents_case ON documents (workspace_id, conversation_id) WHERE conversation_id IS NOT NULL;

-- "Rechnung senden" is a decision of its own: the reply is the invoice from the ERP.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_decision_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_decision_check CHECK (decision IN ('customer_right','customer_wrong','ask_customer','custom','invoice'));

-- Invoice requests recognised on arrival: off, prepare a draft with the invoice, or send it.
ALTER TABLE workspaces ADD COLUMN auto_invoice text NOT NULL DEFAULT 'off' CHECK (auto_invoice IN ('off', 'draft', 'send'));
-- Only messages that arrive after switching it on count (no replies to old mail).
ALTER TABLE workspaces ADD COLUMN auto_invoice_since timestamptz;
-- An approval is a person's, or an operator-activated narrow rule's (e.g. invoice-v1).
ALTER TABLE approvals ALTER COLUMN approved_by DROP NOT NULL;
ALTER TABLE approvals ADD COLUMN auto_rule text;
ALTER TABLE approvals ADD CONSTRAINT approvals_who CHECK (approved_by IS NOT NULL OR auto_rule IS NOT NULL);
