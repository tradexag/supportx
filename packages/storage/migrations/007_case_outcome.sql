-- What was done after the reply, recorded per case by the team, so later
-- automation can learn from real outcomes. The sent reply itself is in outbox.
ALTER TABLE conversations
  ADD COLUMN outcome text CHECK (outcome IN ('none','replacement','refund','partial_refund','return','question','other')),
  ADD COLUMN outcome_note text,
  ADD COLUMN outcome_at timestamptz,
  ADD COLUMN outcome_by uuid REFERENCES users(id);
