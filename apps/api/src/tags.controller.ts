import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { asc, customFieldDefs, eq, tags } from "@orbyt/db";
import { z } from "zod";
import { DbService } from "./db.service";
import { idParam, notFoundIfEmpty, parse } from "./http";
import { Ctx, type Scope, WorkspaceGuard } from "./scope";

const tagInput = z.object({
  name: z.string().trim().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour")
    .nullish(),
});

@Controller("api/w/:workspaceId/tags")
@UseGuards(WorkspaceGuard)
export class TagsController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(tags).orderBy(asc(tags.name)),
    );
  }

  @Post()
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const data = parse(tagInput, body);
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(tags)
        .values({
          workspaceId: scope.workspaceId,
          name: data.name,
          color: data.color ?? null,
        })
        .returning(),
    );
    return row;
  }

  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const data = parse(tagInput.partial(), body);
    const set: Partial<typeof tags.$inferInsert> = {};
    if (data.name !== undefined) set.name = data.name;
    if (data.color !== undefined) set.color = data.color;
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      Object.keys(set).length
        ? tx.update(tags).set(set).where(eq(tags.id, id)).returning()
        : tx.select().from(tags).where(eq(tags.id, id)),
    );
    return notFoundIfEmpty(rows, "Tag");
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.delete(tags).where(eq(tags.id, id)).returning(),
    );
    notFoundIfEmpty(rows, "Tag");
  }
}

const fieldInput = z.object({
  key: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]{0,62}$/,
      "Use lowercase letters, digits and underscores",
    ),
  label: z.string().trim().min(1).max(100),
  type: z.enum(["text", "number", "date", "boolean", "select"]),
  options: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
});

@Controller("api/w/:workspaceId/custom-fields")
@UseGuards(WorkspaceGuard)
export class CustomFieldsController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(customFieldDefs).orderBy(asc(customFieldDefs.key)),
    );
  }

  @Post()
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const data = parse(fieldInput, body);
    if (data.type === "select" && !data.options?.length)
      throw new BadRequestException("A select field needs `options`");
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(customFieldDefs)
        .values({
          workspaceId: scope.workspaceId,
          key: data.key,
          label: data.label,
          type: data.type,
          options: data.type === "select" ? data.options! : null,
        })
        .returning(),
    );
    return row;
  }

  // The key and type are fixed once created (stored values depend on them); label/options change.
  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const data = parse(
      z.object({
        label: fieldInput.shape.label.optional(),
        options: fieldInput.shape.options,
      }),
      body,
    );
    const set: Partial<typeof customFieldDefs.$inferInsert> = {};
    if (data.label !== undefined) set.label = data.label;
    if (data.options !== undefined) set.options = data.options;
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      Object.keys(set).length
        ? tx
            .update(customFieldDefs)
            .set(set)
            .where(eq(customFieldDefs.id, id))
            .returning()
        : tx.select().from(customFieldDefs).where(eq(customFieldDefs.id, id)),
    );
    return notFoundIfEmpty(rows, "Custom field");
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.delete(customFieldDefs).where(eq(customFieldDefs.id, id)).returning(),
    );
    notFoundIfEmpty(rows, "Custom field");
  }
}
