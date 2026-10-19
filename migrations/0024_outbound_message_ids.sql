-- v3.14: messages.message_id of sent mail holds the RFC Message-ID that
-- replies refer to. Earlier sends could store a provider's own id instead
-- (a Resend email id) or an id without angle brackets. Bracket real ids and
-- clear the rest; a cleared id is learned again from the first reply.
UPDATE OR IGNORE messages SET message_id = '<' || message_id || '>'
WHERE direction = 'outbound' AND message_id LIKE '%_@_%' AND message_id NOT LIKE '<%>'
  AND message_id NOT LIKE '% %' AND message_id NOT LIKE '%<%' AND message_id NOT LIKE '%>%';

UPDATE messages SET message_id = NULL
WHERE direction = 'outbound' AND message_id IS NOT NULL AND message_id NOT LIKE '<%_@_%>';
