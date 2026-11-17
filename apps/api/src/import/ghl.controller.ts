import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  and,
  contacts,
  deals,
  eq,
  isNull,
  pipelineStages,
  pipelines,
} from "@orbyt/db";
import { z } from "zod";
import { ContactsService } from "../contacts.service";
import { DbService } from "../db.service";
import { EventsService } from "../events.service";
import { Ctx, type Scope, WorkspaceGuard } from "../scope";
import {
  ghlContactsToCsv,
  ghlStatus,
  parseMoneyCents,
  pick,
  readGhlCsv,
} from "./ghl";

const needCsv = (body: unknown): string => {
  if (typeof body !== "string")
    throw new BadRequestException(
      "Send the GoHighLevel export as the body with Content-Type: text/csv",
    );
  return body;
};

/**
 * Bring a GoHighLevel account over from its CSV exports (Contacts, Opportunities). Contacts first,
 * then opportunities (which attach to those contacts by email). Safe to run twice: contacts are
 * merged by email and opportunities that already exist are skipped.
 * shortcut: CSV only (no API/OAuth connection to GHL), and workflows/funnels/calendars cannot be
 * imported; they have no export format. Rebuild those from the workflow templates.
 */
@Controller("api/w/:workspaceId/import/ghl")
@UseGuards(WorkspaceGuard)
export class GhlImportController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  @Post("contacts")
  @HttpCode(200)
  importContacts(@Ctx() scope: Scope, @Body() body: unknown) {
    return this.contacts.importCsv(scope, ghlContactsToCsv(needCsv(body)));
  }

  @Post("opportunities")
  @HttpCode(200)
  async importOpportunities(@Ctx() scope: Scope, @Body() body: unknown) {
    const rows = readGhlCsv(needCsv(body));
    if (rows.length === 0) throw new BadRequestException("The CSV has no rows");
    const errors: { row: number; message: string }[] = [];
    const stats = {
      created: 0,
      skipped: 0,
      contactsCreated: 0,
      pipelinesCreated: 0,
      stagesCreated: 0,
    };

    await this.dbs.inWorkspace(scope, async (tx) => {
      const pipes = new Map(
        (await tx.select().from(pipelines)).map((p) => [
          p.name.toLowerCase(),
          p.id,
        ]),
      );
      const stageIds = new Map<string, string>();
      const nextPosition = new Map<string, number>();
      for (const s of await tx.select().from(pipelineStages)) {
        stageIds.set(`${s.pipelineId}|${s.name.toLowerCase()}`, s.id);
        nextPosition.set(
          s.pipelineId,
          Math.max(nextPosition.get(s.pipelineId) ?? 0, s.position + 1),
        );
      }
      const contactIds = new Map<string, string>();

      for (const [i, r] of rows.entries()) {
        const row = i + 2; // header is row 1
        const title = pick(r, "opportunity name", "name");
        if (!title) {
          errors.push({ row, message: "Missing opportunity name" });
          continue;
        }
        const pipeName = pick(r, "pipeline") || "GoHighLevel import";
        const stageName = pick(r, "stage", "pipeline stage") || "New";

        let pipelineId = pipes.get(pipeName.toLowerCase());
        if (!pipelineId) {
          const [made] = await tx
            .insert(pipelines)
            .values({ workspaceId: scope.workspaceId, name: pipeName })
            .returning({ id: pipelines.id });
          pipelineId = made!.id;
          pipes.set(pipeName.toLowerCase(), pipelineId);
          stats.pipelinesCreated++;
        }
        const stageKey = `${pipelineId}|${stageName.toLowerCase()}`;
        let stageId = stageIds.get(stageKey);
        if (!stageId) {
          const position = nextPosition.get(pipelineId) ?? 0;
          const [made] = await tx
            .insert(pipelineStages)
            .values({
              workspaceId: scope.workspaceId,
              pipelineId,
              name: stageName,
              position,
            })
            .returning({ id: pipelineStages.id });
          stageId = made!.id;
          stageIds.set(stageKey, stageId);
          nextPosition.set(pipelineId, position + 1);
          stats.stagesCreated++;
        }

        // The person the opportunity belongs to, found (or created) by email.
        const email = pick(r, "email", "contact email").toLowerCase();
        let contactId: string | null = null;
        if (email && z.email().safeParse(email).success) {
          contactId = contactIds.get(email) ?? null;
          if (!contactId) {
            const [found] = await tx
              .select({ id: contacts.id })
              .from(contacts)
              .where(eq(contacts.email, email));
            if (found) contactId = found.id;
            else {
              const [made] = await tx
                .insert(contacts)
                .values({
                  workspaceId: scope.workspaceId,
                  email,
                  name: pick(r, "contact name") || null,
                  phone: pick(r, "phone") || null,
                  source: "gohighlevel",
                  ownerId: scope.userId,
                })
                .returning({ id: contacts.id });
              contactId = made!.id;
              stats.contactsCreated++;
            }
            contactIds.set(email, contactId);
          }
        }

        const [existing] = await tx
          .select({ id: deals.id })
          .from(deals)
          .where(
            and(
              eq(deals.pipelineId, pipelineId),
              eq(deals.title, title),
              contactId
                ? eq(deals.contactId, contactId)
                : isNull(deals.contactId),
            ),
          );
        if (existing) {
          stats.skipped++;
          continue;
        }
        const status = ghlStatus(pick(r, "status"));
        await tx.insert(deals).values({
          workspaceId: scope.workspaceId,
          pipelineId,
          stageId,
          contactId,
          title,
          valueCents: parseMoneyCents(pick(r, "lead value", "value", "amount")),
          status,
          closedAt: status === "open" ? null : new Date(),
          ownerId: scope.userId,
        });
        stats.created++;
      }
    });
    await this.events.emit(scope, {
      type: "deals.imported",
      data: { ...stats, errors: errors.length },
    });
    return { ...stats, errors };
  }
}
