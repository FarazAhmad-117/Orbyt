-- Tenant isolation (plan §4.3 / §8). Hand-written: drizzle-kit does not generate roles or FORCE RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'orbyt_app') THEN
    CREATE ROLE orbyt_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- withWorkspace() does `SET LOCAL ROLE orbyt_app`, so the connecting (owner) user must be a member.
GRANT orbyt_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO orbyt_app;
--> statement-breakpoint
-- organizations/workspaces get no grant yet: they have no policy, so exposing them would leak
-- other tenants' names. Phase 1 adds membership-based policies (incl. the org-level agency view).
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO orbyt_app;
--> statement-breakpoint
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- nullif: after SET LOCAL ends the setting can linger as '' on a pooled connection; '' must mean
-- "no workspace" (zero rows), not a uuid cast error.
CREATE POLICY workspace_isolation ON contacts TO orbyt_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
