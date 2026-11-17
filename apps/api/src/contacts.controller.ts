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
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ContactsService } from "./contacts.service";
import { Ctx, type Scope, WorkspaceGuard } from "./scope";

@Controller("api/w/:workspaceId/contacts")
@UseGuards(WorkspaceGuard)
export class ContactsController {
  constructor(@Inject(ContactsService) private readonly svc: ContactsService) {}

  @Get()
  list(@Ctx() scope: Scope, @Query() query: unknown) {
    return this.svc.list(scope, query);
  }

  // Declared before ":id" so "export"/"import" are not read as ids.
  @Get("export")
  async export(
    @Ctx() scope: Scope,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="contacts.csv"');
    return this.svc.exportCsv(scope);
  }

  @Post("import")
  import(@Ctx() scope: Scope, @Body() body: unknown) {
    if (typeof body !== "string")
      throw new BadRequestException(
        "Send the CSV as the body with Content-Type: text/csv",
      );
    return this.svc.importCsv(scope, body);
  }

  @Post()
  create(@Ctx() scope: Scope, @Body() body: unknown) {
    return this.svc.create(scope, body);
  }

  @Get(":id")
  get(@Ctx() scope: Scope, @Param("id") id: string) {
    return this.svc.get(scope, id);
  }

  @Patch(":id")
  update(@Ctx() scope: Scope, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.update(scope, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") id: string) {
    await this.svc.remove(scope, id);
  }

  @Put(":id/tags")
  setTags(@Ctx() scope: Scope, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.setTags(scope, id, body);
  }
}
