-- RLS for the workflow engine tables (helper defined in 0005_crm_rls.sql).
SELECT app_enable_workspace_rls('workflows');
--> statement-breakpoint
SELECT app_enable_workspace_rls('executions');
--> statement-breakpoint
SELECT app_enable_workspace_rls('execution_steps');
