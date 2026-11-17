import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { AiAdminController, AiFeaturesController } from "./ai/ai.controller";
import { AiService } from "./ai/ai.service";
import { AUTH, createAuth } from "./auth";
import {
  ChannelsController,
  ChannelWebhooksController,
} from "./channels/channels.controller";
import { ChannelsService } from "./channels/channels.service";
import { AuthController, SsoController } from "./auth.controller";
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
import {
  MailboxOAuthController,
  OAuthCallbackController,
} from "./email/oauth.controller";
import { PublicController } from "./email/public.controller";
import { SchedulerService } from "./email/scheduler.service";
import {
  SequencesController,
  SuppressionsController,
} from "./email/sequences.controller";
import { SyncService } from "./email/sync.service";
import { AuditInterceptor } from "./enterprise/audit.interceptor";
import { AuditService } from "./enterprise/audit.service";
import {
  BillingController,
  StripeWebhookController,
} from "./enterprise/billing.controller";
import { BillingService } from "./enterprise/billing.service";
import { EntitlementsService } from "./enterprise/entitlements.service";
import {
  AuditLogsController,
  BrandingController,
  EntitlementsController,
} from "./enterprise/enterprise.controller";
import { OrgAccessService } from "./enterprise/org-access.service";
import { EventsService } from "./events.service";
import {
  FormsController,
  PublicFormsController,
} from "./forms/forms.controller";
import { GhlImportController } from "./import/ghl.controller";
import { ChatService } from "./kb/chat.service";
import {
  ChatAgentsController,
  KbController,
  PublicChatController,
} from "./kb/kb.controller";
import { KbService } from "./kb/kb.service";
import {
  InvitationsController,
  InviteAcceptController,
} from "./invitations.controller";
import { NotifyService } from "./notify.service";
import { HealthController } from "./health.controller";
import { DbErrorFilter } from "./http";
import {
  ApiKeysController,
  WebhooksController,
} from "./integrations.controller";
import { MeController } from "./me.controller";
import { DocsController } from "./openapi";
import { OpsController } from "./ops/ops.controller";
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
import { WorkflowTemplatesController } from "./workflows/templates";
import { WorkflowService } from "./workflows/workflow.service";
import {
  ExecutionsController,
  WorkflowHooksController,
  WorkflowsController,
} from "./workflows/workflows.controller";

@Module({
  controllers: [
    HealthController,
    OpsController,
    DocsController,
    AuthController,
    SsoController,
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
    MailboxOAuthController,
    OAuthCallbackController,
    SequencesController,
    SuppressionsController,
    ConversationsController,
    DeliverabilityController,
    PublicController,
    WorkflowsController,
    ExecutionsController,
    WorkflowHooksController,
    AiAdminController,
    AiFeaturesController,
    ChannelsController,
    ChannelWebhooksController,
    OrgsController,
    MembersController,
    InvitationsController,
    InviteAcceptController,
    AuditLogsController,
    EntitlementsController,
    BrandingController,
    BillingController,
    StripeWebhookController,
    FormsController,
    PublicFormsController,
    KbController,
    ChatAgentsController,
    PublicChatController,
    GhlImportController,
    WorkflowTemplatesController,
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
    NotifyService,
    AuditService,
    EntitlementsService,
    BillingService,
    OrgAccessService,
    KbService,
    ChatService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
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
