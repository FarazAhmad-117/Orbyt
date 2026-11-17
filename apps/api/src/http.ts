import {
  BadRequestException,
  Catch,
  ConflictException,
  type ArgumentsHost,
  Inject,
  NotFoundException,
} from "@nestjs/common";
import { BaseExceptionFilter, HttpAdapterHost } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { z } from "zod";

/**
 * Fastify adapter shared by main.ts and the tests. maxParamLength is raised because the signed
 * unsubscribe/tracking tokens in email links are ~300 characters (the default of 100 answers 414).
 */
export const createAdapter = () =>
  new FastifyAdapter({ routerOptions: { maxParamLength: 2048 } });

/** Validate untrusted input (body/query/params); throws a 400 listing every problem. */
export function parse<T extends z.ZodType>(
  schema: T,
  data: unknown,
): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new BadRequestException({
      message: "Validation failed",
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  return result.data;
}

export const uuid = z.uuid();
export const idParam = (value: string) => parse(uuid, value);

export function notFoundIfEmpty<T>(rows: T[], what = "Resource"): T {
  if (rows.length === 0) throw new NotFoundException(`${what} not found`);
  return rows[0]!;
}

// Postgres errors surface through drizzle as `error.cause.code`.
function pgCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

/** Maps common database errors to clean HTTP errors instead of a 500. */
@Catch()
export class DbErrorFilter extends BaseExceptionFilter {
  constructor(@Inject(HttpAdapterHost) host: HttpAdapterHost) {
    super(host.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost) {
    switch (pgCode(exception)) {
      case "23505":
        return super.catch(new ConflictException("Already exists"), host);
      case "23503":
        return super.catch(
          new ConflictException(
            "Referenced resource is missing or still in use",
          ),
          host,
        );
      case "22P02":
      case "23514":
      case "23502":
        return super.catch(new BadRequestException("Invalid value"), host);
      default:
        return super.catch(exception, host);
    }
  }
}

/** App-wide setup shared by main.ts and the tests. Call before init()/listen(). */
export function configureApp(app: NestFastifyApplication) {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addContentTypeParser(
    "text/csv",
    { parseAs: "string", bodyLimit: 10 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  // (application/x-www-form-urlencoded, used by RFC 8058 one-click unsubscribe, is already parsed
  // by Nest's Fastify adapter.)
}
