import { resolve4, resolveMx, resolveTxt } from "node:dns/promises";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { parse } from "../http";
import { WorkspaceGuard } from "../scope";

/** Thin wrapper around DNS so the checks can be tested without the network. */
@Injectable()
export class DnsService {
  async txt(name: string): Promise<string[]> {
    try {
      return (await resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch {
      return [];
    }
  }
  async mx(name: string): Promise<string[]> {
    try {
      return (await resolveMx(name)).map((r) => r.exchange);
    } catch {
      return [];
    }
  }
  async a(name: string): Promise<string[]> {
    try {
      return await resolve4(name);
    } catch {
      return [];
    }
  }
}

export type CheckStatus = "pass" | "warn" | "fail" | "info";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  record?: string;
}

const query = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      "Enter a domain like example.com",
    ),
  selector: z
    .string()
    .trim()
    .regex(/^[a-z0-9._-]{1,63}$/i)
    .optional(),
});

/** Evaluates the sender-authentication DNS records people most often get wrong. */
export async function checkDomain(
  dns: DnsService,
  domain: string,
  selector?: string,
): Promise<Check[]> {
  const checks: Check[] = [];

  const spf = (await dns.txt(domain)).filter((t) => /^v=spf1\b/i.test(t));
  if (spf.length === 0)
    checks.push({
      name: "SPF",
      status: "fail",
      detail: "No SPF record. Publish a TXT record starting with v=spf1.",
    });
  else if (spf.length > 1)
    checks.push({
      name: "SPF",
      status: "fail",
      detail: "More than one SPF record: receivers will reject all of them.",
      record: spf.join(" | "),
    });
  else {
    const all = /\s([+\-~?]?)all\b/i.exec(spf[0]!)?.[1] ?? "";
    checks.push(
      all === "-"
        ? {
            name: "SPF",
            status: "pass",
            detail: "SPF is published and ends in -all.",
            record: spf[0],
          }
        : all === "~"
          ? {
              name: "SPF",
              status: "pass",
              detail: "SPF is published (~all, soft fail).",
              record: spf[0],
            }
          : {
              name: "SPF",
              status: "warn",
              detail:
                "SPF does not end in -all or ~all, so it does not restrict senders.",
              record: spf[0],
            },
    );
  }

  const dmarc = (await dns.txt(`_dmarc.${domain}`)).find((t) =>
    /^v=DMARC1\b/i.test(t),
  );
  if (!dmarc)
    checks.push({
      name: "DMARC",
      status: "fail",
      detail:
        "No DMARC record at _dmarc." +
        domain +
        ". Start with v=DMARC1; p=none; rua=mailto:you@" +
        domain,
    });
  else {
    const policy = /\bp=(none|quarantine|reject)\b/i
      .exec(dmarc)?.[1]
      ?.toLowerCase();
    checks.push(
      policy === "none"
        ? {
            name: "DMARC",
            status: "warn",
            detail:
              "DMARC is monitoring only (p=none). Move to quarantine/reject once reports look clean.",
            record: dmarc,
          }
        : policy
          ? {
              name: "DMARC",
              status: "pass",
              detail: `DMARC policy is p=${policy}.`,
              record: dmarc,
            }
          : {
              name: "DMARC",
              status: "fail",
              detail: "DMARC record has no valid p= policy.",
              record: dmarc,
            },
    );
  }

  if (selector) {
    const dkim = (await dns.txt(`${selector}._domainkey.${domain}`)).find((t) =>
      /v=DKIM1|\bp=/i.test(t),
    );
    checks.push(
      dkim
        ? {
            name: "DKIM",
            status: "pass",
            detail: `DKIM key found for selector "${selector}".`,
            record: dkim.slice(0, 120),
          }
        : {
            name: "DKIM",
            status: "fail",
            detail: `No DKIM key at ${selector}._domainkey.${domain}.`,
          },
    );
  } else
    checks.push({
      name: "DKIM",
      status: "info",
      detail:
        "Pass ?selector=<your selector> (e.g. google, selector1) to check DKIM.",
    });

  const mx = await dns.mx(domain);
  checks.push(
    mx.length
      ? {
          name: "MX",
          status: "pass",
          detail: `Mail is received by ${mx.slice(0, 3).join(", ")}.`,
        }
      : {
          name: "MX",
          status: "warn",
          detail: "No MX records: replies cannot reach this domain.",
        },
  );

  // Spamhaus Domain Block List: NXDOMAIN = not listed. 127.255.255.x means the resolver is not allowed to ask.
  const dbl = await dns.a(`${domain}.dbl.spamhaus.org`);
  checks.push(
    dbl.length === 0
      ? {
          name: "Blocklist (Spamhaus DBL)",
          status: "pass",
          detail: "Not listed.",
        }
      : dbl.some((a) => a.startsWith("127.255.255."))
        ? {
            name: "Blocklist (Spamhaus DBL)",
            status: "info",
            detail:
              "Could not check: Spamhaus refuses queries from public resolvers. Use your own resolver.",
          }
        : {
            name: "Blocklist (Spamhaus DBL)",
            status: "fail",
            detail: `Listed (${dbl.join(", ")}). Fix the cause and request delisting.`,
          },
  );
  return checks;
}

@Controller("api/w/:workspaceId/deliverability")
@UseGuards(WorkspaceGuard)
export class DeliverabilityController {
  constructor(@Inject(DnsService) private readonly dns: DnsService) {}

  @Get()
  async check(@Query() rawQuery: unknown) {
    const q = parse(query, rawQuery);
    const checks = await checkDomain(this.dns, q.domain, q.selector);
    return {
      domain: q.domain,
      checks,
      ok: checks.every((c) => c.status === "pass" || c.status === "info"),
      note: "Passing these checks helps but does not guarantee inbox placement.",
    };
  }
}
