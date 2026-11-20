-- Hand-written (D-097): a customer message counts as answered when a reply
-- covers it, and an assistant reply covers messages up to its turn's trigger,
-- not up to the moment it was stored. The load test found customers whose
-- message arrived while the previous turn was running: the reply, stored a
-- moment later, made the new message look answered, and nobody replied.
CREATE OR REPLACE FUNCTION unanswered_by_assistant(p_older_than interval, p_newer_than interval, p_limit integer)
  RETURNS TABLE (tenant_id uuid, conversation_id uuid, message_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.tenant_id, c.id, last_in.id
    FROM conversations c
    CROSS JOIN LATERAL (
      SELECT m.id, m.created_at FROM messages m
      WHERE m.conversation_id = c.id AND m.direction = 'inbound'
      ORDER BY m.created_at DESC
      LIMIT 1
    ) last_in
    WHERE c.state = 'assistant'
      AND c.last_inbound_at > now() - p_newer_than
      AND last_in.created_at < now() - p_older_than
      AND last_in.created_at > now() - p_newer_than
      AND NOT EXISTS (
        SELECT 1 FROM assistant_turns t
        JOIN messages trig ON trig.id = t.trigger_message_id
        WHERE t.conversation_id = c.id AND trig.created_at >= last_in.created_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM messages o
        LEFT JOIN assistant_turns t ON t.reply_message_id = o.id
        WHERE o.conversation_id = c.id AND o.direction = 'outbound'
          AND o.status NOT IN ('failed', 'cancelled')
          AND t.id IS NULL
          AND o.created_at > last_in.created_at
      )
    ORDER BY last_in.created_at
    LIMIT p_limit
  $$;
