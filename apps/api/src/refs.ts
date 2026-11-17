import { BadRequestException } from "@nestjs/common";
import {
  companies,
  contacts,
  deals,
  eq,
  pipelines,
  pipelineStages,
  type Tx,
} from "@orbyt/db";

// Foreign keys ignore tenancy, so every id a client sends must be re-checked under RLS: if the row
// is not visible in this workspace the reference is rejected (no cross-tenant links).

export async function assertContact(tx: Tx, id: string) {
  const rows = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.id, id));
  if (rows.length === 0) throw new BadRequestException("Unknown contactId");
}

export async function assertCompany(tx: Tx, id: string) {
  const rows = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, id));
  if (rows.length === 0) throw new BadRequestException("Unknown companyId");
}

export async function assertDeal(tx: Tx, id: string) {
  const rows = await tx
    .select({ id: deals.id })
    .from(deals)
    .where(eq(deals.id, id));
  if (rows.length === 0) throw new BadRequestException("Unknown dealId");
}

export async function assertPipeline(tx: Tx, id: string) {
  const rows = await tx
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.id, id));
  if (rows.length === 0) throw new BadRequestException("Unknown pipelineId");
}

/** The stage must exist in this workspace AND belong to the given pipeline. */
export async function assertStage(tx: Tx, stageId: string, pipelineId: string) {
  const rows = await tx
    .select({ pipelineId: pipelineStages.pipelineId })
    .from(pipelineStages)
    .where(eq(pipelineStages.id, stageId));
  if (rows.length === 0 || rows[0]!.pipelineId !== pipelineId)
    throw new BadRequestException("Unknown stageId for this pipeline");
}
