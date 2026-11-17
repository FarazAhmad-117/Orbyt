-- RLS for the platform tables (helpers from 0005_crm_rls.sql / 0003_membership_rls.sql).
-- Invitations are looked up by token hash before any workspace is known: enabled, not forced.
SELECT app_enable_workspace_rls('invitations', false);
--> statement-breakpoint
SELECT app_enable_workspace_rls('forms');
--> statement-breakpoint
SELECT app_enable_workspace_rls('form_submissions');
--> statement-breakpoint
SELECT app_enable_workspace_rls('kb_documents');
--> statement-breakpoint
SELECT app_enable_workspace_rls('chat_agents');
--> statement-breakpoint
SELECT app_enable_workspace_rls('audit_logs');
--> statement-breakpoint
-- The audit log is append-only for the application role.
REVOKE UPDATE, DELETE ON audit_logs FROM orbyt_app;
--> statement-breakpoint
-- Billing state: organization members can read it; only the system connection (Stripe webhook) writes.
GRANT SELECT ON subscriptions TO orbyt_app;
--> statement-breakpoint
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY member_read ON subscriptions FOR SELECT TO orbyt_app
  USING (app_is_org_member(organization_id));
--> statement-breakpoint
-- Full-text retrieval for the knowledge base ('simple' config: works for any language).
ALTER TABLE kb_documents ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED;
--> statement-breakpoint
CREATE INDEX kb_documents_search_idx ON kb_documents USING gin (search);
