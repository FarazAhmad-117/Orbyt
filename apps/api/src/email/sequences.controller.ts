import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  and,
  asc,
  contacts,
  desc,
  emailEvents,
  enrollments,
  eq,
  inArray,
  lt,
  mailboxes,
  sequences,
  sequenceSteps,
  sql,
  suppressions,
  type Tx,
} from "@orbyt/db";
import { z } from "zod";
import { DbService } from "../db.service";
import { EventsService } from "../events.service";
import { idParam, notFoundIfEmpty, parse } from "../http";
import { Ctx, type Scope, WorkspaceGuard } from "../scope";
import { enrollContacts } from "./enroll";
import { isValidTimezone } from "./window";

const stepInput = z.object({
  delayHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 90)
    .default(0),
  // An empty subject on a follow-up continues the previous thread ("Re: ...").
  subject: z.string().trim().max(300).default(""),
  body: z.string().trim().min(1).max(20_000),
});
const settings = z.object({
  name: z.string().trim().min(1).max(200),
  mailboxIds: z.array(z.uuid()).max(20),
  timezone: z.string().refine(isValidTimezone, "Unknown IANA timezone"),
  windowStartHour: z.number().int().min(0).max(23),
  windowEndHour: z.number().int().min(1).max(24),
  sendDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  stopOnReply: z.boolean(),
  trackOpens: z.boolean(),
  trackClicks: z.boolean(),
  footer: z.string().trim().max(1000).nullish(),
});
const createInput = settings
  .partial()
  .required({ name: true })
  .extend({ steps: z.array(stepInput).min(1).max(10) });
const patchInput = settings
  .partial()
  .extend({ steps: z.array(stepInput).min(1).max(10).optional() });

function checkSteps(steps?: z.infer<typeof stepInput>[]) {
  if (steps && !steps[0]!.subject)
    throw new BadRequestException("The first step needs a subject");
}

async function assertMailboxes(tx: Tx, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await tx
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(inArray(mailboxes.id, unique));
  if (rows.length !== unique.length)
    throw new BadRequestException("Unknown mailboxId");
}

async function withSteps(tx: Tx, rows: (typeof sequences.$inferSelect)[]) {
  if (rows.length === 0) return [];
  const steps = await tx
    .select()
    .from(sequenceSteps)
    .where(
      inArray(
        sequenceSteps.sequenceId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(sequenceSteps.position));
  return rows.map((r) => ({
    ...r,
    steps: steps.filter((s) => s.sequenceId === r.id),
  }));
}

@Controller("api/w/:workspaceId/sequences")
@UseGuards(WorkspaceGuard)
export class SequencesController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, async (tx) =>
      withSteps(
        tx,
        await tx.select().from(sequences).orderBy(desc(sequences.id)),
      ),
    );
  }

  @Post()
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(createInput, body);
    checkSteps(d.steps);
    if ((d.windowStartHour ?? 9) >= (d.windowEndHour ?? 17))
      throw new BadRequestException(
        "windowStartHour must be before windowEndHour",
      );
    return this.dbs.inWorkspace(scope, async (tx) => {
      await assertMailboxes(tx, d.mailboxIds ?? []);
      const { steps, ...rest } = d;
      const [seq] = await tx
        .insert(sequences)
        .values({
          ...rest,
          workspaceId: scope.workspaceId,
          footer: rest.footer ?? null,
        })
        .returning();
      await tx.insert(sequenceSteps).values(
        steps.map((s, position) => ({
          ...s,
          workspaceId: scope.workspaceId,
          sequenceId: seq!.id,
          position,
        })),
      );
      return (await withSteps(tx, [seq!]))[0]!;
    });
  }

  @Get(":id")
  async get(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(sequences)
        .where(eq(sequences.id, id));
      notFoundIfEmpty(rows, "Sequence");
      return (await withSteps(tx, rows))[0]!;
    });
  }

  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const d = parse(patchInput, body);
    checkSteps(d.steps);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [current] = await tx
        .select()
        .from(sequences)
        .where(eq(sequences.id, id));
      if (!current) throw new NotFoundException("Sequence not found");
      if (d.mailboxIds) await assertMailboxes(tx, d.mailboxIds);
      const { steps, ...rest } = d;
      const start = rest.windowStartHour ?? current.windowStartHour;
      const end = rest.windowEndHour ?? current.windowEndHour;
      if (start >= end)
        throw new BadRequestException(
          "windowStartHour must be before windowEndHour",
        );
      if (Object.keys(rest).length)
        await tx
          .update(sequences)
          .set({
            ...rest,
            footer: rest.footer === undefined ? undefined : rest.footer,
          })
          .where(eq(sequences.id, id));
      if (steps) {
        // Replacing steps keeps positions 0..n-1, so enrollments already part-way keep their index.
        await tx.delete(sequenceSteps).where(eq(sequenceSteps.sequenceId, id));
        await tx.insert(sequenceSteps).values(
          steps.map((s, position) => ({
            ...s,
            workspaceId: scope.workspaceId,
            sequenceId: id,
            position,
          })),
        );
      }
      return (
        await withSteps(
          tx,
          await tx.select().from(sequences).where(eq(sequences.id, id)),
        )
      )[0]!;
    });
  }

  /** Compliance gate: a footer with the sender's postal address is required before anything is sent. */
  @Post(":id/activate")
  @HttpCode(200)
  async activate(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const seq = await this.dbs.inWorkspace(scope, async (tx) => {
      const [current] = await tx
        .select()
        .from(sequences)
        .where(eq(sequences.id, id));
      if (!current) throw new NotFoundException("Sequence not found");
      if (!current.footer?.trim())
        throw new BadRequestException(
          "Add a footer with your postal address before activating (required by CAN-SPAM and similar laws)",
        );
      if (current.mailboxIds.length === 0)
        throw new BadRequestException("Pick at least one mailbox");
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(sequenceSteps)
        .where(eq(sequenceSteps.sequenceId, id));
      if (n === 0) throw new BadRequestException("Add at least one step");
      return (
        await tx
          .update(sequences)
          .set({ status: "active" })
          .where(eq(sequences.id, id))
          .returning()
      )[0]!;
    });
    await this.events.emit(scope, { type: "sequence.activated", data: { id } });
    return seq;
  }

  @Post(":id/pause")
  @HttpCode(200)
  async pause(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .update(sequences)
        .set({ status: "paused" })
        .where(eq(sequences.id, id))
        .returning(),
    );
    return notFoundIfEmpty(rows, "Sequence");
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .delete(sequences)
        .where(eq(sequences.id, id))
        .returning({ id: sequences.id }),
    );
    notFoundIfEmpty(rows, "Sequence");
  }

  @Post(":id/enroll")
  async enroll(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const { contactIds } = parse(
      z.object({ contactIds: z.array(z.uuid()).min(1).max(1000) }),
      body,
    );
    const result = await this.dbs.inWorkspace(scope, (tx) =>
      enrollContacts(tx, scope, id, contactIds),
    );
    if (result.enrolled)
      await this.events.emit(scope, {
        type: "sequence.enrolled",
        data: { id, count: result.enrolled },
      });
    return result;
  }

  @Get(":id/enrollments")
  list_enrollments(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Query() rawQuery: unknown,
  ) {
    const id = idParam(rawId);
    const q = parse(
      z.object({
        status: z
          .enum([
            "active",
            "completed",
            "replied",
            "bounced",
            "unsubscribed",
            "paused",
            "error",
          ])
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.uuid().optional(),
      }),
      rawQuery,
    );
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select({
          enrollment: enrollments,
          email: contacts.email,
          name: contacts.name,
        })
        .from(enrollments)
        .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
        .where(
          and(
            eq(enrollments.sequenceId, id),
            q.status ? eq(enrollments.status, q.status) : undefined,
            q.cursor ? lt(enrollments.id, q.cursor) : undefined,
          ),
        )
        .orderBy(desc(enrollments.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({
          ...r.enrollment,
          email: r.email,
          name: r.name,
        })),
        nextCursor:
          rows.length > q.limit ? page[page.length - 1]!.enrollment.id : null,
      };
    });
  }

  @Patch(":id/enrollments/:enrollmentId")
  async setEnrollment(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Param("enrollmentId") rawEnrollmentId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const enrollmentId = idParam(rawEnrollmentId);
    const { status } = parse(
      z.object({ status: z.enum(["active", "paused"]) }),
      body,
    );
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .update(enrollments)
        .set(
          status === "active" ? { status, nextSendAt: new Date() } : { status },
        )
        .where(
          and(
            eq(enrollments.id, enrollmentId),
            eq(enrollments.sequenceId, id),
            // Only live enrollments can be paused/resumed; finished ones stay finished.
            inArray(enrollments.status, ["active", "paused"]),
          ),
        )
        .returning(),
    );
    return notFoundIfEmpty(rows, "Enrollment");
  }

  @Get(":id/stats")
  async stats(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select({ id: sequences.id })
        .from(sequences)
        .where(eq(sequences.id, id));
      notFoundIfEmpty(rows, "Sequence");
      const byStatus = await tx
        .select({ status: enrollments.status, n: sql<number>`count(*)::int` })
        .from(enrollments)
        .where(eq(enrollments.sequenceId, id))
        .groupBy(enrollments.status);
      const byEvent = await tx
        .select({
          type: emailEvents.type,
          total: sql<number>`count(*)::int`,
          unique: sql<number>`count(distinct ${emailEvents.enrollmentId})::int`,
        })
        .from(emailEvents)
        .innerJoin(enrollments, eq(enrollments.id, emailEvents.enrollmentId))
        .where(eq(enrollments.sequenceId, id))
        .groupBy(emailEvents.type);
      const events = Object.fromEntries(
        byEvent.map((e) => [e.type, { total: e.total, unique: e.unique }]),
      );
      const reached = events.sent?.unique ?? 0;
      return {
        enrollments: Object.fromEntries(byStatus.map((s) => [s.status, s.n])),
        events,
        replyRate: reached ? (events.reply?.unique ?? 0) / reached : 0,
        bounceRate: reached
          ? ((events.bounce_hard?.unique ?? 0) +
              (events.bounce_soft?.unique ?? 0)) /
            reached
          : 0,
      };
    });
  }
}

@Controller("api/w/:workspaceId/suppressions")
@UseGuards(WorkspaceGuard)
export class SuppressionsController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(suppressions).orderBy(desc(suppressions.id)).limit(500),
    );
  }

  @Post()
  async add(@Ctx() scope: Scope, @Body() body: unknown) {
    const { email } = parse(
      z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) }),
      body,
    );
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(suppressions)
        .values({ workspaceId: scope.workspaceId, email, reason: "manual" })
        .onConflictDoUpdate({
          target: [suppressions.workspaceId, suppressions.email],
          set: { reason: "manual" },
        })
        .returning(),
    );
    return row;
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .delete(suppressions)
        .where(eq(suppressions.id, id))
        .returning({ id: suppressions.id }),
    );
    notFoundIfEmpty(rows, "Suppression");
  }
}
