import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AiAdminController, AiFeaturesController } from "./ai/ai.controller";
import { AiService } from "./ai/ai.service";
import { AUTH, createAuth } from "./auth";
import {
  ChannelsController,
  ChannelWebhooksController,
} from "./channels/channels.controller";
import { ChannelsService } from "./channels/channels.service";
import { AuthController } from "./auth.controller";
import { CompaniesController } from "./companies.controller";
import { ContactsController } from "./contacts.controller";
import { ContactsService } from "./contacts.service";
import { DbService } from "./db.service";
import { ConversationsController } from "./email/conversations.controller";
import {
  DeliverabilityController,
  DnsService,
} from "./email/deliverability.controller";
import { MailService } from "./email/mail.service";
import { MailboxesController } from "./email/mailboxes.controller";
import { PublicController } from "./email/public.controller";
import { SchedulerService } from "./email/scheduler.service";
import {
  SequencesController,
  SuppressionsController,
} from "./email/sequences.controller";
import { SyncService } from "./email/sync.service";
import { EventsService } from "./events.service";
import { HealthController } from "./health.controller";
import { DbErrorFilter } from "./http";
import {
  ApiKeysController,
  WebhooksController,
} from "./integrations.controller";
import { MeController } from "./me.controller";
import { DocsController } from "./openapi";
import {
  DealsController,
  PipelinesController,
  StagesController,
} from "./sales.controller";
import { MembersController, OrgsController } from "./members.controller";
import { AdminGuard, SessionOnlyGuard, WorkspaceGuard } from "./scope";
import { CustomFieldsController, TagsController } from "./tags.controller";
import { WebhooksService } from "./webhooks.service";
import {
  NotesController,
  TasksController,
  TimelineController,
} from "./work.controller";
import { WorkflowService } from "./workflows/workflow.service";
import {
  ExecutionsController,
  WorkflowsController,
} from "./workflows/workflows.controller";

@Module({
  controllers: [
    HealthController,
    DocsController,
    AuthController,
    MeController,
    ContactsController,
    CompaniesController,
    TagsController,
    CustomFieldsController,
    PipelinesController,
    StagesController,
    DealsController,
    TasksController,
    NotesController,
    TimelineController,
    ApiKeysController,
    WebhooksController,
    MailboxesController,
    SequencesController,
    SuppressionsController,
    ConversationsController,
    DeliverabilityController,
    PublicController,
    WorkflowsController,
    ExecutionsController,
    AiAdminController,
    AiFeaturesController,
    ChannelsController,
    ChannelWebhooksController,
    OrgsController,
    MembersController,
  ],
  providers: [
    DbService,
    EventsService,
    ContactsService,
    WebhooksService,
    MailService,
    SchedulerService,
    SyncService,
    DnsService,
    WorkflowService,
    AiService,
    ChannelsService,
    WorkspaceGuard,
    SessionOnlyGuard,
    AdminGuard,
    { provide: APP_FILTER, useClass: DbErrorFilter },
    {
      provide: AUTH,
      inject: [DbService],
      useFactory: (dbs: DbService) => createAuth(dbs.db),
    },
  ],
})
export class AppModule {}
