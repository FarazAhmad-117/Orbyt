-- Membership-based read access to organizations / workspaces / members (plan §4.3, §8).
-- Callers set `app.user_id` via withUser(); all writes to these tables are system operations
-- (bare connection), so orbyt_app only gets SELECT.
--
-- RLS is ENABLED but deliberately not FORCED on these tables: the SECURITY DEFINER helpers below
-- must read the membership tables as the owner, otherwise a policy that calls a helper that reads
-- the same table would recurse. orbyt_app is not the owner, so it is always restricted.
-- Tenant-DATA tables (e.g. contacts) stay FORCEd; tenancy.test.ts enforces that split.
CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_is_org_member(org uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM organization_members
      WHERE organization_id = org AND user_id = app_user_id()
    )
  $$;
--> statement-breakpoint
-- Workspace members, plus org owners/admins (the agency can open every sub-account).
CREATE FUNCTION app_can_access_workspace(ws uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_id = ws AND user_id = app_user_id()
    ) OR EXISTS (
      SELECT 1 FROM workspaces w
      JOIN organization_members m ON m.organization_id = w.organization_id
      WHERE w.id = ws AND m.user_id = app_user_id() AND m.role IN ('owner', 'admin')
    )
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_id(), app_is_org_member(uuid), app_can_access_workspace(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_id(), app_is_org_member(uuid), app_can_access_workspace(uuid) TO orbyt_app;
--> statement-breakpoint
GRANT SELECT ON organizations, workspaces, organization_members, workspace_members TO orbyt_app;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY member_read ON organizations FOR SELECT TO orbyt_app
  USING (app_is_org_member(id));
--> statement-breakpoint
CREATE POLICY member_read ON workspaces FOR SELECT TO orbyt_app
  USING (app_can_access_workspace(id));
--> statement-breakpoint
CREATE POLICY member_read ON organization_members FOR SELECT TO orbyt_app
  USING (app_is_org_member(organization_id));
--> statement-breakpoint
CREATE POLICY member_read ON workspace_members FOR SELECT TO orbyt_app
  USING (app_can_access_workspace(workspace_id));
