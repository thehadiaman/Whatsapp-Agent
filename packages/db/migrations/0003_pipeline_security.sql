-- Row-level security and grants for the WhatsApp pipeline (see 0001 for the model).

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channels
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customers
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE conversation_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversation_transitions
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE message_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_status_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_status_events
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Routing an incoming webhook happens before its tenant is known: this answers
-- only "which channel and tenant own this phone number ID?".
CREATE FUNCTION channel_route(p_provider channel_provider, p_phone_number_id text)
  RETURNS TABLE (channel_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.tenant_id FROM channels c
    WHERE c.provider = p_provider AND c.phone_number_id = p_phone_number_id
  $$;

-- The worker's outbox sweeper re-enqueues replies whose job was lost (e.g. a
-- crash between commit and enqueue). It learns IDs only, then works per tenant.
CREATE FUNCTION pending_outbound(p_older_than interval, p_limit integer)
  RETURNS TABLE (tenant_id uuid, message_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.tenant_id, m.id FROM messages m
    WHERE m.direction = 'outbound' AND m.status IN ('queued', 'sending')
      AND m.status_at < now() - p_older_than
    ORDER BY m.status_at
    LIMIT p_limit
  $$;

CREATE FUNCTION platform_list_dead_letters(p_limit integer)
  RETURNS TABLE (
    id uuid, tenant_name text, queue text, reference text, reason text,
    attempts integer, failed_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT d.id, t.name, d.queue, d.reference, d.reason, d.attempts, d.failed_at
    FROM dead_letters d LEFT JOIN tenants t ON t.id = d.tenant_id
    ORDER BY d.failed_at DESC
    LIMIT p_limit
  $$;

REVOKE ALL ON FUNCTION channel_route(channel_provider, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pending_outbound(interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_list_dead_letters(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_route(channel_provider, text) TO app_user;
GRANT EXECUTE ON FUNCTION pending_outbound(interval, integer) TO app_user;
GRANT EXECUTE ON FUNCTION platform_list_dead_letters(integer) TO app_platform;

GRANT SELECT ON channels TO app_user;
GRANT SELECT, INSERT, UPDATE ON customers TO app_user;
GRANT SELECT, INSERT, UPDATE ON conversations TO app_user;
GRANT SELECT, INSERT ON conversation_transitions TO app_user;
GRANT SELECT, INSERT, UPDATE ON messages TO app_user;
GRANT SELECT, INSERT ON message_status_events TO app_user;

-- Platform-level tables. Raw events are written by the API and read by the
-- worker; dead letters are written by the worker and read only by platform admins.
GRANT SELECT, INSERT, UPDATE ON webhook_events TO app_user;
GRANT INSERT ON dead_letters TO app_user;
