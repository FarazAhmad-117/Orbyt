-- RLS for the AI gateway tables (helper defined in 0005_crm_rls.sql).
SELECT app_enable_workspace_rls('ai_providers');
--> statement-breakpoint
SELECT app_enable_workspace_rls('ai_usage');
--> statement-breakpoint
SELECT app_enable_workspace_rls('ai_settings');
--> statement-breakpoint
SELECT app_enable_workspace_rls('ai_prompts');
