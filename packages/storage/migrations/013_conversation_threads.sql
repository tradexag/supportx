-- Further mail threads that belong to an existing case (a customer's follow-up
-- mail that the mailbox put in a new thread). Later mails in that thread join the case.
CREATE TABLE conversation_threads (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_thread_key text NOT NULL,
  conversation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, connection_id, external_thread_key),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);
