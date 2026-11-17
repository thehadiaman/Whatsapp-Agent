-- Tenant isolation, enforced by Postgres rather than by application code.
--
-- The API and worker connect as app_user, which cannot bypass row-level
-- security and owns no tables. They set the tenant per transaction:
--     select set_config('app.tenant_id', '<uuid>', true)
-- Every tenant-owned table only shows and accepts rows for that tenant.
-- With no tenant set, app_current_tenant() is NULL and every policy fails
-- closed: reads return nothing and writes are rejected.

CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- tenants: a tenant can see and edit only its own row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- Signing in happens before any tenant is known, so the API needs exactly one
-- question answered across tenants: "which tenant and role does this user
-- have?" This function answers only that, for one user id.
CREATE FUNCTION auth_membership(p_user_id uuid)
  RETURNS TABLE (tenant_id uuid, role tenant_role)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT m.tenant_id, m.role FROM memberships m WHERE m.user_id = p_user_id $$;

-- Platform admins see a list of tenants, nothing inside them. Only the
-- app_platform role may call this.
CREATE FUNCTION platform_list_tenants()
  RETURNS TABLE (id uuid, slug text, name text, created_at timestamptz, members bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.id, t.slug, t.name, t.created_at, count(m.user_id)
    FROM tenants t LEFT JOIN memberships m ON m.tenant_id = t.id
    GROUP BY t.id
    ORDER BY t.created_at
  $$;

REVOKE ALL ON FUNCTION auth_membership(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_list_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_membership(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO app_platform;
GRANT EXECUTE ON FUNCTION app_current_tenant() TO app_user;

GRANT USAGE ON SCHEMA public TO app_user, app_platform;

-- Identity tables are not tenant-owned; Better Auth reads and writes them.
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, accounts, verifications TO app_user;

-- Tenant tables: only what the application needs.
GRANT SELECT, UPDATE ON tenants TO app_user;
GRANT SELECT ON memberships TO app_user;
-- The audit log is append-only for the application.
GRANT SELECT, INSERT ON audit_log TO app_user;
