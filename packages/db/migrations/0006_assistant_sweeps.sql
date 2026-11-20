-- Hand-written: the sweeper's view of work whose job was lost. The worker
-- runs these as app_user with no tenant set, so row-level security would hide
-- every row; like pending_outbound, they return IDs only and run as owner.

-- Knowledge sources stuck in queued or reading: the ingest job was lost.
CREATE FUNCTION pending_knowledge_sources(p_older_than interval, p_limit integer)
  RETURNS TABLE (tenant_id uuid, source_id uuid, version integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT s.tenant_id, s.id, s.version FROM knowledge_sources s
    WHERE s.status IN ('queued', 'reading') AND s.updated_at < now() - p_older_than
    ORDER BY s.updated_at
    LIMIT p_limit
  $$;
--> statement-breakpoint

-- Conversations the assistant holds whose newest customer message has neither
-- a turn nor a reply: the assistant job was lost between commit and enqueue.
-- Only recent messages count; an old silence is for a person to pick up.
CREATE FUNCTION unanswered_by_assistant(p_older_than interval, p_newer_than interval, p_limit integer)
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
      AND NOT EXISTS (SELECT 1 FROM assistant_turns t WHERE t.trigger_message_id = last_in.id)
      AND NOT EXISTS (
        SELECT 1 FROM messages o
        WHERE o.conversation_id = c.id AND o.direction = 'outbound' AND o.created_at > last_in.created_at
      )
    ORDER BY last_in.created_at
    LIMIT p_limit
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION pending_knowledge_sources(interval, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION unanswered_by_assistant(interval, interval, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pending_knowledge_sources(interval, integer) TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION unanswered_by_assistant(interval, interval, integer) TO app_user;
