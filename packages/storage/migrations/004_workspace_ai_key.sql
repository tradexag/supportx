-- Each workspace may bring its own Claude API key (encrypted in secrets).
ALTER TABLE workspaces ADD COLUMN ai_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN ai_key_hint text;
