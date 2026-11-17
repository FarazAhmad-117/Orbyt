export const FEATURES = ["sso", "audit_logs", "white_label"] as const;
export type Feature = (typeof FEATURES)[number];

export interface PlanLimits {
  workspaces: number;
  mailboxes: number;
  features: readonly Feature[];
}

/**
 * Plans for the hosted cloud (active only when STRIPE_SECRET_KEY is set). Self-hosted community
 * installs have no limits; a license key adds features (and optionally caps).
 */
export const PLANS = {
  free: { workspaces: 1, mailboxes: 2, features: [] },
  pro: { workspaces: 3, mailboxes: 10, features: [] },
  // "sso" is not part of any plan: it is configured per installation and needs a license key.
  agency: {
    workspaces: 100,
    mailboxes: 200,
    features: ["audit_logs", "white_label"],
  },
} as const satisfies Record<string, PlanLimits>;
export type PlanId = keyof typeof PLANS;
export const isPlan = (v: string): v is PlanId => v in PLANS;
