import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { mergeMap } from "rxjs";
import type { ScopedRequest } from "../scope";
import { AuditService } from "./audit.service";

// Resources whose changes are worth an audit entry (credentials, access, automation, integrations).
// "invitations" records itself (it knows the email). Request bodies are never stored: they can
// contain secrets (provider API keys, mailbox passwords).
const AUDITED = new Set([
  "api-keys",
  "webhooks",
  "members",
  "mailboxes",
  "ai",
  "channels",
  "workflows",
  "sequences",
  "suppressions",
  "forms",
  "kb",
  "chat-agents",
  "custom-fields",
  "pipelines",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `POST /api/w/<ws>/workflows/<id>/activate` -> { action: "workflows.activate", target }. */
export function describeRequest(method: string, url: string) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS")
    return null;
  const path = url.split("?")[0]!.split("/").filter(Boolean);
  if (path[0] !== "api" || path[1] !== "w" || path.length < 4) return null;
  const [resource, ...rest] = path.slice(3);
  if (!resource || !AUDITED.has(resource)) return null;
  const id = rest.find((s) => UUID.test(s));
  const verb = rest.filter((s) => !UUID.test(s))[0];
  const action =
    verb ??
    (method === "POST" ? "create" : method === "DELETE" ? "delete" : "update");
  return {
    action: `${resource}.${action}`,
    target: { type: resource, id },
  };
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<ScopedRequest>();
    return next.handle().pipe(
      // Runs only for successful responses; awaited so the entry exists once the caller sees "ok".
      mergeMap(async (value: unknown) => {
        const d = req.scope ? describeRequest(req.method, req.url) : null;
        if (d && req.scope)
          await this.audit.record(req.scope, d.action, d.target);
        return value;
      }),
    );
  }
}
