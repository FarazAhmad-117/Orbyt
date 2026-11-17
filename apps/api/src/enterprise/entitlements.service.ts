import { HttpException, Inject, Injectable } from "@nestjs/common";
import {
  and,
  eq,
  inArray,
  mailboxes,
  sql,
  subscriptions,
  workspaces,
} from "@orbyt/db";
import { DbService } from "../db.service";
import {
  publicKeyFromEnv,
  verifyLicense,
  type LicensePayload,
} from "./license";
import { FEATURES, isPlan, PLANS, type Feature, type PlanId } from "./plans";

export interface Entitlements {
  plan: PlanId | "community";
  features: Set<Feature>;
  /** null = unlimited */
  maxWorkspaces: number | null;
  maxMailboxes: number | null;
}

const paymentRequired = (message: string) => new HttpException(message, 402);

/** What an organization may use: its Stripe plan (cloud) and/or a valid license key (self-host). */
@Injectable()
export class EntitlementsService {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  get cloud() {
    return !!process.env.STRIPE_SECRET_KEY;
  }

  license(): LicensePayload | null {
    const key = process.env.ORBYT_LICENSE_KEY;
    if (!key) return null;
    const r = verifyLicense(key, publicKeyFromEnv());
    if (!r.ok) {
      console.warn(`[license] ignored: ${r.reason}`);
      return null;
    }
    return r.payload;
  }

  /** SSO is configured for the whole installation, so it needs a license with the "sso" feature. */
  ssoAllowed(): boolean {
    return !!this.license()?.features.includes("sso");
  }

  async orgOf(workspaceId: string): Promise<string | null> {
    const [ws] = await this.dbs.db
      .select({ org: workspaces.organizationId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return ws?.org ?? null;
  }

  async forOrg(orgId: string): Promise<Entitlements> {
    const lic = this.license();
    const features = new Set<Feature>(
      (lic?.features ?? []).filter((f): f is Feature =>
        (FEATURES as readonly string[]).includes(f),
      ),
    );
    if (!this.cloud)
      return {
        plan: "community",
        features,
        maxWorkspaces: lic?.maxWorkspaces ?? null,
        maxMailboxes: lic?.maxMailboxes ?? null,
      };
    const [sub] = await this.dbs.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, orgId));
    const paid =
      sub && ["active", "trialing"].includes(sub.status) && isPlan(sub.plan)
        ? sub.plan
        : "free";
    for (const f of PLANS[paid].features) features.add(f);
    return {
      plan: paid,
      features,
      maxWorkspaces: PLANS[paid].workspaces,
      maxMailboxes: PLANS[paid].mailboxes,
    };
  }

  async assertOrgFeature(orgId: string, feature: Feature) {
    if (!(await this.forOrg(orgId)).features.has(feature))
      throw paymentRequired(
        `"${feature}" is not included in your plan. Upgrade, or add a license key.`,
      );
  }

  async assertFeature(workspaceId: string, feature: Feature) {
    const org = await this.orgOf(workspaceId);
    if (!org)
      throw paymentRequired(`"${feature}" is not included in your plan.`);
    await this.assertOrgFeature(org, feature);
  }

  async assertCanAddWorkspace(orgId: string) {
    const e = await this.forOrg(orgId);
    if (e.maxWorkspaces === null) return;
    const [{ n } = { n: 0 }] = await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaces)
      .where(eq(workspaces.organizationId, orgId));
    if (n >= e.maxWorkspaces)
      throw paymentRequired(
        `Your plan allows ${e.maxWorkspaces} workspace(s). Upgrade to add more.`,
      );
  }

  async assertCanAddMailbox(workspaceId: string) {
    const org = await this.orgOf(workspaceId);
    if (!org) return;
    const e = await this.forOrg(org);
    if (e.maxMailboxes === null) return;
    const ids = (
      await this.dbs.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.organizationId, org))
    ).map((w) => w.id);
    const [{ n } = { n: 0 }] = await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(mailboxes)
      .where(and(inArray(mailboxes.workspaceId, ids)));
    if (n >= e.maxMailboxes)
      throw paymentRequired(
        `Your plan allows ${e.maxMailboxes} mailbox(es). Upgrade to connect more.`,
      );
  }
}
