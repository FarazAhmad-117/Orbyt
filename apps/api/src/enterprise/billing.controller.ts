import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { idParam, parse } from "../http";
import { BillingService, verifyStripeSignature } from "./billing.service";
import { OrgAccessService } from "./org-access.service";
import { PLANS } from "./plans";

/** Subscription management for an organization (owners/admins). Active when STRIPE_SECRET_KEY is set. */
@Controller("api/orgs/:orgId/billing")
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(OrgAccessService) private readonly access: OrgAccessService,
  ) {}

  @Get()
  async get(@Req() req: FastifyRequest, @Param("orgId") rawOrg: string) {
    const orgId = idParam(rawOrg);
    await this.access.requireAdmin(req, orgId);
    return { ...(await this.billing.get(orgId)), plans: PLANS };
  }

  @Post("checkout")
  @HttpCode(200)
  async checkout(
    @Req() req: FastifyRequest,
    @Param("orgId") rawOrg: string,
    @Body() body: unknown,
  ) {
    const orgId = idParam(rawOrg);
    await this.access.requireAdmin(req, orgId);
    const { plan } = parse(z.object({ plan: z.enum(["pro", "agency"]) }), body);
    return this.billing.checkout(orgId, plan);
  }

  @Post("portal")
  @HttpCode(200)
  async portal(@Req() req: FastifyRequest, @Param("orgId") rawOrg: string) {
    const orgId = idParam(rawOrg);
    await this.access.requireAdmin(req, orgId);
    return this.billing.portal(orgId);
  }
}

/** Stripe calls this; authenticity comes from the signature, not from a session. */
@Controller("api/stripe")
export class StripeWebhookController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  @Post("webhook")
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers("stripe-signature") signature: string | undefined,
  ) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !req.rawBody)
      throw new BadRequestException("Webhook is not configured");
    if (!verifyStripeSignature(req.rawBody, signature, secret))
      throw new BadRequestException("Invalid signature");
    await this.billing.handleEvent(JSON.parse(req.rawBody.toString("utf8")));
    return { received: true };
  }
}
