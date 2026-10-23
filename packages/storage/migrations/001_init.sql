-- SupportX: initial schema.
-- Every business table carries workspace_id; composite foreign keys make it
-- impossible to attach a record to an object of another workspace.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- Reply settings; no merchant-specific constants in code.
  reply_signature text NOT NULL DEFAULT 'Freundliche Grüße
Ihr Kundenservice',
  reply_tone text NOT NULL DEFAULT 'freundlich, sachlich, kurz',
  default_language text NOT NULL DEFAULT 'de',
  allowed_link_prefixes text[] NOT NULL DEFAULT '{}',
  ai_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'agent', 'viewer')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE user_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Encrypted credentials (AES-256-GCM, key from APP_ENCRYPTION_KEY). Referenced by id only.
CREATE TABLE secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE merchant_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('email','amazon','ebay','kaufland','shop_apotheke','docmorris','shopify')),
  -- How orders of this account are recognised in weclapp (verified on each returned record).
  order_scope_field text NOT NULL DEFAULT 'none' CHECK (order_scope_field IN ('salesChannel','customerId','ecommerceConnectionId','tag','none')),
  order_scope_value text NOT NULL DEFAULT '',
  paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE erp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('weclapp')),
  display_name text NOT NULL,
  base_url text NOT NULL,
  -- weclapp fields searched for a customer's order reference, in order.
  search_fields text[] NOT NULL DEFAULT '{orderNumberAtCustomer,orderNumber}',
  secret_id uuid,
  status text NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','ok','error')),
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, provider),
  FOREIGN KEY (workspace_id, secret_id) REFERENCES secrets(workspace_id, id)
);

CREATE TABLE channel_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('microsoft_graph')),
  display_name text NOT NULL,
  -- Non-secret settings: tenantId, clientId, mailbox, folders. Secrets via secret_id.
  config jsonb NOT NULL DEFAULT '{}',
  secret_id uuid,
  default_merchant_account_id uuid,
  default_source_platform text NOT NULL DEFAULT 'email',
  -- Sending is off until an operator enables it after a verified reply route.
  send_enabled boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT false,
  health text NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown','ok','error')),
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, secret_id) REFERENCES secrets(workspace_id, id),
  FOREIGN KEY (workspace_id, default_merchant_account_id) REFERENCES merchant_accounts(workspace_id, id)
);

-- A reply route is verified per connection and source platform (e.g. DocMorris
-- via the support mailbox) after a controlled reply reached the right thread.
CREATE TABLE reply_route_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  source_platform text NOT NULL,
  verified_by uuid REFERENCES users(id),
  evidence_note text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES channel_connections(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX reply_route_active ON reply_route_verifications (connection_id, source_platform) WHERE revoked_at IS NULL;

CREATE TABLE routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  priority int NOT NULL DEFAULT 100,
  match_type text NOT NULL CHECK (match_type IN ('from_domain','from_address','to_address','subject_contains')),
  pattern text NOT NULL,
  source_platform text NOT NULL,
  merchant_account_id uuid,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES channel_connections(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, merchant_account_id) REFERENCES merchant_accounts(workspace_id, id)
);

CREATE TABLE sync_cursors (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  resource text NOT NULL,
  cursor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, resource),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES channel_connections(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_thread_key text NOT NULL,
  merchant_account_id uuid,
  source_platform text NOT NULL,
  routing_rule_id uuid,
  subject text NOT NULL DEFAULT '',
  customer_address text,
  customer_name text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','closed')),
  assignee_user_id uuid REFERENCES users(id),
  -- Incremented on every change that must invalidate an earlier approval.
  version int NOT NULL DEFAULT 1,
  latest_inbound_message_id uuid,
  order_match_status text NOT NULL DEFAULT 'pending'
    CHECK (order_match_status IN ('pending','unique','ambiguous','missing','no_reference','no_account','error')),
  order_references jsonb NOT NULL DEFAULT '[]',
  last_message_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, connection_id, external_thread_key),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES channel_connections(workspace_id, id),
  FOREIGN KEY (workspace_id, merchant_account_id) REFERENCES merchant_accounts(workspace_id, id)
);
CREATE INDEX conversations_list ON conversations (workspace_id, status, last_message_at DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_message_id text NOT NULL,
  internet_message_id text,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  -- customer: real customer text; echo: our own send seen again; manual_external:
  -- a reply written outside this application; platform_notice: system mail.
  kind text NOT NULL CHECK (kind IN ('customer','echo','manual_external','platform_notice')),
  from_address text NOT NULL,
  from_name text,
  to_addresses jsonb NOT NULL DEFAULT '[]',
  reply_to jsonb NOT NULL DEFAULT '[]',
  subject text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  headers jsonb NOT NULL DEFAULT '{}',
  alias_keys text[] NOT NULL DEFAULT '{}',
  has_attachments boolean NOT NULL DEFAULT false,
  outbox_id uuid,
  received_at timestamptz NOT NULL,
  removed_remotely_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, connection_id, external_message_id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);
-- The same RFC Message-ID seen again on the same connection (e.g. moved between
-- folders) is the same message, not a new customer request.
CREATE UNIQUE INDEX messages_internet_id ON messages (workspace_id, connection_id, internet_message_id) WHERE internet_message_id IS NOT NULL;
CREATE INDEX messages_conversation ON messages (conversation_id, received_at);
CREATE INDEX messages_alias ON messages USING gin (alias_keys);

ALTER TABLE conversations ADD FOREIGN KEY (workspace_id, latest_inbound_message_id) REFERENCES messages(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE internal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE order_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  merchant_account_id uuid,
  provider text NOT NULL DEFAULT 'weclapp',
  status text NOT NULL CHECK (status IN ('unique','ambiguous','missing','no_reference','no_account','error')),
  references_tried jsonb NOT NULL DEFAULT '[]',
  candidates jsonb NOT NULL DEFAULT '[]',
  external_order_id text,
  matched_by text,
  linked_by text NOT NULL CHECK (linked_by IN ('auto','user')),
  linked_by_user_id uuid REFERENCES users(id),
  error text,
  -- Normalised weclapp snapshot incl. shipments, parcels and invoices.
  snapshot jsonb,
  retrieved_at timestamptz,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, merchant_account_id) REFERENCES merchant_accounts(workspace_id, id)
);
CREATE UNIQUE INDEX order_links_current ON order_links (conversation_id) WHERE is_current;

CREATE TABLE drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  based_on_conversation_version int NOT NULL,
  inbound_message_id uuid NOT NULL,
  order_link_id uuid,
  intent text NOT NULL,
  summary text NOT NULL DEFAULT '',
  body text NOT NULL,
  cited_fact_ids text[] NOT NULL DEFAULT '{}',
  facts jsonb NOT NULL DEFAULT '[]',
  missing_information jsonb NOT NULL DEFAULT '[]',
  suggested_actions jsonb NOT NULL DEFAULT '[]',
  risks text[] NOT NULL DEFAULT '{}',
  issues jsonb NOT NULL DEFAULT '[]',
  generated_by text NOT NULL,
  ai_model text,
  prompt_version text,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','edited','superseded','sent','discarded')),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, inbound_message_id) REFERENCES messages(workspace_id, id)
);
CREATE INDEX drafts_conversation ON drafts (conversation_id, created_at DESC);

-- An approval is bound to exact draft and conversation revisions.
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  draft_version int NOT NULL,
  conversation_version int NOT NULL,
  body_sha256 text NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  invalidation_reason text,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, draft_id) REFERENCES drafts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  draft_version int NOT NULL,
  approval_id uuid NOT NULL,
  in_reply_to_message_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  body text NOT NULL,
  expected_recipient text,
  state text NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned','dispatching','provider_accepted','confirmed','delivery_uncertain','failed','suppressed')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  external_message_id text,
  dispatched_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id),
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals(workspace_id, id)
);
-- One live reply per inbound message. Failed/suppressed entries do not block a new attempt;
-- an uncertain one does until a person resolves it.
CREATE UNIQUE INDEX outbox_one_live_reply ON outbox (workspace_id, idempotency_key) WHERE state NOT IN ('failed','suppressed');

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  dedupe_key text,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');
CREATE INDEX jobs_ready ON jobs (run_at) WHERE status = 'queued';

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('user','worker','system')),
  actor_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_target ON audit_events (workspace_id, target_type, target_id, created_at);
