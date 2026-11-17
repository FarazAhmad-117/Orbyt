CREATE TABLE "execution_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"output" jsonb,
	"error" text,
	"finished_at" timestamp with time zone,
	CONSTRAINT "execution_steps_node_uniq" UNIQUE("execution_id","node_id"),
	CONSTRAINT "execution_steps_status_check" CHECK ("execution_steps"."status" in ('pending', 'done', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"graph" jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contact_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "executions_status_check" CHECK ("executions"."status" in ('running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_type" text DEFAULT 'manual' NOT NULL,
	"trigger_event" text,
	"graph" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_status_check" CHECK ("workflows"."status" in ('draft', 'active', 'paused')),
	CONSTRAINT "workflows_trigger_check" CHECK ("workflows"."trigger_type" in ('event', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_steps_due_idx" ON "execution_steps" USING btree ("workspace_id","status","run_at");--> statement-breakpoint
CREATE INDEX "executions_workflow_idx" ON "executions" USING btree ("workflow_id","started_at");--> statement-breakpoint
CREATE INDEX "workflows_trigger_idx" ON "workflows" USING btree ("workspace_id","status","trigger_event");