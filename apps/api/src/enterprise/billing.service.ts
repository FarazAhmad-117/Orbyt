import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { eq, organizations, subscriptions } from "@orbyt/db";
import { DbService } from "../db.service";
import { isPlan, type PlanId } from "./plans";

const stripeBase = () =>
  process.env.STRIPE_API_BASE ?? "https://api.stripe.com";
const publicUrl = () =>
  (
    process.env.PUBLIC_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");

/** Maps our paid plans to the Stripe price ids you create in your Stripe dashboard. */
const priceFor = (plan: "pro" | "agency") =>
  plan === "pro"
    ? process.env.STRIPE_PRICE_PRO
    : process.env.STRIPE_PRICE_AGENCY;
const planForPrice = (priceId: string | undefined): PlanId | null =>
  !priceId
    ? null
    : priceId === process.env.STRIPE_PRICE_PRO
      ? "pro"
      : priceId === process.env.STRIPE_PRICE_AGENCY
        ? "agency"
        : null;

/**
 * Verifies a `Stripe-Signature` header (`t=<unix>,v1=<hex hmac-sha256 of "t.payload">`) against
 * the exact request bytes. Rejects anything older than `toleranceSec` (replay protection).
 */
export function verifyStripeSignature(
  payload: Buffer,
  header: string | undefined,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0 || Math.abs(nowSec - Number(t)) > toleranceSec)
    return false;
  const expected = createHmac("sha256", secret)
    .update(`${t}.`)
    .update(payload)
    .digest();
  return sigs.some((s) => {
    const given = Buffer.from(s, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

interface StripeEvent {
  id: string;
  type: string;
  // Stripe objects are large and vary per event type; only the fields read below matter.
  data: { object: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

@Injectable()
export class BillingService {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  private async stripe<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new BadRequestException("Billing is not enabled");
    const res = await fetch(`${stripeBase()}/v1/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    if (!res.ok)
      throw new BadGatewayException(
        `Stripe: ${json.error?.message ?? res.status}`,
      );
    return json as T;
  }

  async get(orgId: string) {
    const [sub] = await this.dbs.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, orgId));
    return {
      enabled: !!process.env.STRIPE_SECRET_KEY,
      plan: sub && isPlan(sub.plan) ? sub.plan : "free",
      status: sub?.status ?? "none",
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      hasCustomer: !!sub?.stripeCustomerId,
    };
  }

  private async customerId(orgId: string): Promise<string> {
    const [sub] = await this.dbs.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, orgId));
    if (sub?.stripeCustomerId) return sub.stripeCustomerId;
    const [org] = await this.dbs.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    const customer = await this.stripe<{ id: string }>("customers", {
      name: org?.name ?? "Orbyt customer",
      "metadata[orgId]": orgId,
    });
    await this.dbs.db
      .insert(subscriptions)
      .values({ organizationId: orgId, stripeCustomerId: customer.id })
      .onConflictDoUpdate({
        target: subscriptions.organizationId,
        set: { stripeCustomerId: customer.id },
      });
    return customer.id;
  }

  async checkout(orgId: string, plan: "pro" | "agency") {
    const price = priceFor(plan);
    if (!price)
      throw new BadRequestException(
        `No Stripe price configured for "${plan}" (set STRIPE_PRICE_${plan.toUpperCase()})`,
      );
    const customer = await this.customerId(orgId);
    const session = await this.stripe<{ url: string }>("checkout/sessions", {
      mode: "subscription",
      customer,
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: `${publicUrl()}/app?billing=success`,
      cancel_url: `${publicUrl()}/app?billing=cancelled`,
      client_reference_id: orgId,
      "metadata[orgId]": orgId,
      "metadata[plan]": plan,
      "subscription_data[metadata][orgId]": orgId,
    });
    return { url: session.url };
  }

  async portal(orgId: string) {
    const customer = await this.customerId(orgId);
    const session = await this.stripe<{ url: string }>(
      "billing_portal/sessions",
      { customer, return_url: `${publicUrl()}/app` },
    );
    return { url: session.url };
  }

  /** Applies a (signature-verified) Stripe event to our subscription state. Idempotent. */
  async handleEvent(event: StripeEvent) {
    const obj = event.data.object;
    if (event.type === "checkout.session.completed") {
      const orgId = obj.metadata?.orgId as string | undefined;
      const plan = obj.metadata?.plan as string | undefined;
      if (!orgId || !plan || !isPlan(plan)) return;
      await this.upsert(orgId, {
        plan,
        status: "active",
        stripeCustomerId: obj.customer as string,
        stripeSubscriptionId: obj.subscription as string,
      });
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const orgId =
        (obj.metadata?.orgId as string | undefined) ??
        (await this.orgByCustomer(obj.customer as string));
      if (!orgId) return;
      const deleted = event.type === "customer.subscription.deleted";
      const plan = planForPrice(obj.items?.data?.[0]?.price?.id);
      await this.upsert(orgId, {
        status: deleted ? "canceled" : (obj.status as string),
        ...(deleted ? { plan: "free" } : plan ? { plan } : {}),
        stripeCustomerId: obj.customer as string,
        stripeSubscriptionId: obj.id as string,
        currentPeriodEnd: obj.current_period_end
          ? new Date(Number(obj.current_period_end) * 1000)
          : null,
      });
    }
  }

  private async orgByCustomer(customerId: string) {
    const [row] = await this.dbs.db
      .select({ org: subscriptions.organizationId })
      .from(subscriptions)
      .where(eq(subscriptions.stripeCustomerId, customerId));
    return row?.org;
  }

  private async upsert(
    orgId: string,
    set: Partial<typeof subscriptions.$inferInsert>,
  ) {
    await this.dbs.db
      .insert(subscriptions)
      .values({ organizationId: orgId, ...set })
      .onConflictDoUpdate({
        target: subscriptions.organizationId,
        set: { ...set, updatedAt: new Date() },
      });
  }
}
