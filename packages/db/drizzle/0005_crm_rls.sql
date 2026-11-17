-- RLS for the CRM tables, via a reusable helper so every future workspace table is one line:
--   SELECT app_enable_workspace_rls('some_table');
-- The guard test in tenancy.test.ts fails if a new public table is not protected.
CREATE FUNCTION app_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint
-- force_rls = false is for the rare table that must be read by the owner connection before a
-- workspace is known (api_keys: looked up by hash). Everything else stays FORCEd.
CREATE FUNCTION app_enable_workspace_rls(tbl regclass, force_rls boolean DEFAULT true) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO orbyt_app', tbl);
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  IF force_rls THEN
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  END IF;
  EXECUTE format(
    'CREATE POLICY workspace_isolation ON %s TO orbyt_app USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
    tbl);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_workspace_id(), app_enable_workspace_rls(regclass, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_workspace_id() TO orbyt_app;
--> statement-breakpoint
SELECT app_enable_workspace_rls('companies');
--> statement-breakpoint
SELECT app_enable_workspace_rls('tags');
--> statement-breakpoint
SELECT app_enable_workspace_rls('contact_tags');
--> statement-breakpoint
SELECT app_enable_workspace_rls('custom_field_defs');
--> statement-breakpoint
SELECT app_enable_workspace_rls('pipelines');
--> statement-breakpoint
SELECT app_enable_workspace_rls('pipeline_stages');
--> statement-breakpoint
SELECT app_enable_workspace_rls('deals');
--> statement-breakpoint
SELECT app_enable_workspace_rls('tasks');
--> statement-breakpoint
SELECT app_enable_workspace_rls('notes');
--> statement-breakpoint
SELECT app_enable_workspace_rls('activities');
--> statement-breakpoint
SELECT app_enable_workspace_rls('webhooks');
--> statement-breakpoint
SELECT app_enable_workspace_rls('api_keys', false);
