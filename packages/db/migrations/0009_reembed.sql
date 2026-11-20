-- Hand-written: when the embedding model changes (mock to Cohere, or a newer
-- Cohere), passages embedded by another model can no longer be compared with
-- a query. The worker calls this at start: each such source gets a new
-- version and goes back to the queue, and its old passages stay searchable
-- by keyword until the new ones replace them. Fleet-wide, so it runs as owner
-- and returns IDs only, like the other sweeps.
CREATE FUNCTION requeue_stale_embeddings(p_model text, p_limit integer)
  RETURNS TABLE (tenant_id uuid, source_id uuid, version integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE knowledge_sources s
       SET version = s.version + 1, status = 'queued', updated_at = now()
     WHERE s.status = 'ready'
       AND s.id IN (
         SELECT DISTINCT p.source_id FROM knowledge_passages p
         WHERE p.embedding_model <> p_model
         LIMIT p_limit
       )
    RETURNING s.tenant_id, s.id, s.version
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION requeue_stale_embeddings(text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requeue_stale_embeddings(text, integer) TO app_user;
