-- Amazon's copies of our own buyer messages ("Hier ist eine Kopie der E-Mail, die du an … gesendet hast")
-- were filed as requests. Sort existing ones out like the detection now does for new mails:
-- only cases filed automatically, with a single inbound mail and nothing sent.
WITH own AS (
  SELECT c.id, c.workspace_id
    FROM conversations c
    JOIN LATERAL (SELECT subject, body_text FROM messages WHERE conversation_id = c.id AND direction = 'inbound' ORDER BY received_at LIMIT 1) m ON true
   WHERE c.category = 'support'
     AND c.category_source <> 'person'
     AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.conversation_id = c.id)
     AND (SELECT count(*) FROM messages x WHERE x.conversation_id = c.id AND x.direction = 'inbound') = 1
     AND (left(m.body_text, 2000) ~* 'hier ist eine kopie (der|deiner|ihrer) (e-?mail|nachricht),? die (du|sie) an .{1,80}? gesendet ha(st|ben)'
       OR left(m.body_text, 2000) ~* 'here is a copy of the (e-?mail|message) you sent to')
), sorted AS (
  UPDATE conversations c SET category = 'info', category_source = 'auto', category_reason = 'Kopie einer eigenen Nachricht an den Käufer', updated_at = now()
    FROM own WHERE c.id = own.id
  RETURNING c.id, c.workspace_id
), drafts_closed AS (
  UPDATE drafts d SET status = 'superseded', updated_at = now()
    FROM sorted WHERE d.workspace_id = sorted.workspace_id AND d.conversation_id = sorted.id AND d.status IN ('proposed','edited')
  RETURNING d.id
)
UPDATE approvals a SET invalidated_at = now(), invalidation_reason = 'als eigene Kopie aussortiert'
  FROM sorted WHERE a.workspace_id = sorted.workspace_id AND a.conversation_id = sorted.id AND a.invalidated_at IS NULL;
