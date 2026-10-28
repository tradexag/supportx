-- "Individuell": the person types what to answer, SupportX words it.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_decision_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_decision_check CHECK (decision IN ('customer_right','customer_wrong','ask_customer','custom'));
