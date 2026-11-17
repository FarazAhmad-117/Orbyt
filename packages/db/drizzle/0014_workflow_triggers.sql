ALTER TABLE "workflows" DROP CONSTRAINT "workflows_trigger_check";--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "webhook_token" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "schedule_minutes" integer;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workflows_schedule_idx" ON "workflows" USING btree ("workspace_id","status","next_run_at");--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_trigger_check" CHECK ("workflows"."trigger_type" in ('event', 'manual', 'webhook', 'schedule'));