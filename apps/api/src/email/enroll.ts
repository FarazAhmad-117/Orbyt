import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  and,
  contacts,
  enrollments,
  eq,
  inArray,
  sequences,
  sequenceSteps,
  suppressions,
  type Tx,
} from "@orbyt/db";
import type { Scope } from "../scope";

export interface EnrollResult {
  enrolled: number;
  skipped: {
    contactId: string;
    reason: "not_found" | "suppressed" | "already_enrolled";
  }[];
}

/**
 * Enrols contacts in a sequence. Shared by the sequences API and the workflow engine so both
 * follow the same rules: unknown contacts, suppressed addresses and duplicates are skipped.
 */
export async function enrollContacts(
  tx: Tx,
  scope: Scope,
  sequenceId: string,
  contactIds: string[],
): Promise<EnrollResult> {
  const ids = [...new Set(contactIds)];
  const [seq] = await tx
    .select()
    .from(sequences)
    .where(eq(sequences.id, sequenceId));
  if (!seq) throw new NotFoundException("Sequence not found");
  const [first] = await tx
    .select()
    .from(sequenceSteps)
    .where(
      and(
        eq(sequenceSteps.sequenceId, sequenceId),
        eq(sequenceSteps.position, 0),
      ),
    );
  if (!first)
    throw new BadRequestException(
      "Add at least one step before enrolling contacts",
    );

  const found = await tx
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(inArray(contacts.id, ids));
  const byId = new Map(found.map((c) => [c.id, c]));
  const blocked = new Set(
    (
      await tx
        .select({ email: suppressions.email })
        .from(suppressions)
        .where(
          inArray(
            suppressions.email,
            found.map((c) => c.email),
          ),
        )
    ).map((s) => s.email),
  );
  const existing = new Set(
    (
      await tx
        .select({ c: enrollments.contactId })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.sequenceId, sequenceId),
            inArray(enrollments.contactId, ids),
          ),
        )
    ).map((r) => r.c),
  );

  const skipped: EnrollResult["skipped"] = [];
  const toInsert: string[] = [];
  for (const contactId of ids) {
    const c = byId.get(contactId);
    if (!c) skipped.push({ contactId, reason: "not_found" });
    else if (blocked.has(c.email))
      skipped.push({ contactId, reason: "suppressed" });
    else if (existing.has(contactId))
      skipped.push({ contactId, reason: "already_enrolled" });
    else toInsert.push(contactId);
  }
  const startAt = new Date(Date.now() + first.delayHours * 3_600_000);
  if (toInsert.length)
    await tx.insert(enrollments).values(
      toInsert.map((contactId) => ({
        workspaceId: scope.workspaceId,
        sequenceId,
        contactId,
        nextSendAt: startAt,
      })),
    );
  return { enrolled: toInsert.length, skipped };
}
