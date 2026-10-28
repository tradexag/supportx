-- What a person decided before the reply was written (no reply is generated without it).
ALTER TABLE drafts ADD COLUMN decision text CHECK (decision IN ('customer_right','customer_wrong','ask_customer'));
