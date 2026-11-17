import "reflect-metadata";
import { Controller, Get, Header, Inject } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { z } from "zod";
import { contactInput } from "./contacts.service";

// Nest's RequestMethod enum values for the verbs we document.
const VERB: Record<number, string> = {
  0: "get",
  1: "post",
  2: "put",
  3: "delete",
  4: "patch",
};

// Request bodies documented from the SAME zod schemas the API validates with.
// Keyed by "VERB /path". Add more as endpoints stabilise.
const BODIES: Record<string, z.ZodType> = {
  "post /api/w/{workspaceId}/contacts": contactInput,
  "patch /api/w/{workspaceId}/contacts/{id}": contactInput.partial(),
};

const join = (...parts: string[]) =>
  "/" +
  parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");

type Handler = (...args: unknown[]) => unknown;

/** Builds an OpenAPI 3.1 document by reading the Nest controllers' route metadata. */
export function buildOpenApi(controllers: (new (...a: never[]) => unknown)[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const ctrl of controllers) {
    const base = Reflect.getMetadata("path", ctrl) as
      string | string[] | undefined;
    if (base === undefined) continue;
    const tag = ctrl.name.replace(/Controller$/, "");
    const cookieOnly = /ApiKeys|Webhooks/.test(ctrl.name);
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const fn = (ctrl.prototype as Record<string, Handler>)[name];
      if (typeof fn !== "function") continue;
      const verb = VERB[Reflect.getMetadata("method", fn) as number];
      if (!verb) continue; // not a route (or @All)
      const sub = Reflect.getMetadata("path", fn) as string | string[];
      const path = join(
        String([base].flat()[0]),
        String([sub].flat()[0] ?? ""),
      ).replace(/:([A-Za-z]+)/g, "{$1}");
      const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      }));
      const operation: Record<string, unknown> = {
        tags: [tag],
        operationId: `${ctrl.name}_${name}`,
        summary: name.replace(/([A-Z])/g, " $1").toLowerCase(),
        parameters: params,
        responses: {
          "200": { description: "OK" },
          "400": { description: "Validation failed (body lists the issues)" },
          "401": { description: "Not authenticated" },
          "404": {
            description: "Not found (also returned for other tenants' ids)",
          },
        },
      };
      if (path.startsWith("/api/w/"))
        operation.security = cookieOnly
          ? [{ cookieAuth: [] }]
          : [{ cookieAuth: [] }, { bearerAuth: [] }];
      const body = BODIES[`${verb} ${path}`];
      if (body)
        operation.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: z.toJSONSchema(body, { io: "input" }),
            },
          },
        };
      (paths[path] ??= {})[verb] = operation;
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Orbyt API",
      version: "0.0.0",
      description:
        "Workspace-scoped REST API. Authenticate with a session cookie (sign in via /api/auth/*) or " +
        "`Authorization: Bearer <api key>`. Authentication endpoints (/api/auth/*) are provided by better-auth. " +
        "Request bodies are documented for core endpoints; response schemas are not yet.",
    },
    paths,
    components: {
      securitySchemes: {
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Workspace API key (orbyt_...)",
        },
      },
    },
  };
}

const DOCS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Orbyt API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: "/api/openapi.json", dom_id: "#ui" });</script></body></html>`;

@Controller("api")
export class DocsController {
  private spec?: ReturnType<typeof buildOpenApi>;

  constructor(
    @Inject(ModulesContainer) private readonly modules: ModulesContainer,
  ) {}

  @Get("openapi.json")
  openapi() {
    if (!this.spec) {
      const controllers = [...this.modules.values()].flatMap((m) =>
        [...m.controllers.values()].map((w) => w.metatype as new () => unknown),
      );
      this.spec = buildOpenApi(controllers);
    }
    return this.spec;
  }

  @Get("docs")
  @Header("content-type", "text/html; charset=utf-8")
  docs() {
    return DOCS_HTML;
  }
}
