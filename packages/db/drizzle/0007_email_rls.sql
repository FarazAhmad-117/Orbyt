-- RLS for the email engine tables (helper defined in 0005_crm_rls.sql).
SELECT app_enable_workspace_rls('mailboxes');
--> statement-breakpoint
SELECT app_enable_workspace_rls('sequences');
--> statement-breakpoint
SELECT app_enable_workspace_rls('sequence_steps');
--> statement-breakpoint
SELECT app_enable_workspace_rls('enrollments');
--> statement-breakpoint
SELECT app_enable_workspace_rls('conversations');
--> statement-breakpoint
SELECT app_enable_workspace_rls('messages');
--> statement-breakpoint
SELECT app_enable_workspace_rls('email_events');
--> statement-breakpoint
SELECT app_enable_workspace_rls('suppressions');
