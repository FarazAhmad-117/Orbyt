/**
 * OAuth2 for Gmail / Google Workspace and Microsoft 365 mailboxes (SMTP/IMAP with XOAUTH2).
 * Only the long-lived refresh token is stored (encrypted); access tokens are fetched on demand
 * and cached in memory by MailService.
 *
 * Configure with GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET and MICROSOFT_CLIENT_ID/
 * MICROSOFT_CLIENT_SECRET (+ MICROSOFT_TENANT, default "common"). Register
 * `${PUBLIC_URL}/api/oauth/callback` as the redirect URI with each provider. The *_AUTH_URL /
 * *_TOKEN_URL variables override the endpoints (used by the tests' mock provider).
 */
export type OAuthProvider = "google" | "microsoft";
export const isOAuthProvider = (v: string): v is OAuthProvider =>
  v === "google" || v === "microsoft";

export interface ProviderConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  authUrl: string;
  tokenUrl: string;
  scope: string;
  extraAuthParams: Record<string, string>;
  smtp: { host: string; port: number; secure: boolean };
  imap: { host: string; port: number; secure: boolean };
}

export function providerConfig(p: OAuthProvider): ProviderConfig {
  if (p === "google")
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authUrl:
        process.env.GOOGLE_AUTH_URL ??
        "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl:
        process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
      scope: "openid email https://mail.google.com/",
      // prompt=consent makes Google return a refresh token every time, not only on first consent.
      extraAuthParams: { access_type: "offline", prompt: "consent" },
      smtp: { host: "smtp.gmail.com", port: 465, secure: true },
      imap: { host: "imap.gmail.com", port: 993, secure: true },
    };
  const tenant = process.env.MICROSOFT_TENANT || "common"; // (|| not ??: compose passes unset variables as "")
  return {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    authUrl:
      process.env.MICROSOFT_AUTH_URL ??
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl:
      process.env.MICROSOFT_TOKEN_URL ??
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scope:
      "openid email offline_access https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All",
    extraAuthParams: { prompt: "select_account" },
    smtp: { host: "smtp.office365.com", port: 587, secure: false }, // STARTTLS
    imap: { host: "outlook.office365.com", port: 993, secure: true },
  };
}

export const redirectUri = () =>
  `${(process.env.PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/oauth/callback`;

/**
 * "invalid": the provider refused (revoked/expired grant) so the mailbox needs to be reconnected.
 * "transient": network or provider outage, try again later.
 */
export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly kind: "invalid" | "transient",
  ) {
    super(message);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

async function tokenRequest(
  p: OAuthProvider,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const cfg = providerConfig(p);
  if (!cfg.clientId || !cfg.clientSecret)
    throw new OAuthError(`${p} OAuth is not configured`, "invalid");
  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        ...params,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new OAuthError(
      `Could not reach ${p}: ${(err as Error).message}`,
      "transient",
    );
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    const why = body.error_description ?? body.error;
    throw new OAuthError(
      `${p} refused the login${why ? `: ${String(why)}` : ""}`,
      res.status >= 500 ? "transient" : "invalid",
    );
  }
  return body as unknown as TokenResponse;
}

export async function exchangeCode(p: OAuthProvider, code: string) {
  const t = await tokenRequest(p, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });
  if (!t.refresh_token)
    throw new OAuthError(
      `${p} did not return a refresh token (remove the app's access in your account and connect again)`,
      "invalid",
    );
  return {
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    idToken: t.id_token,
  };
}

export async function refreshAccessToken(
  p: OAuthProvider,
  refreshToken: string,
) {
  const t = await tokenRequest(p, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return {
    accessToken: t.access_token,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
}

/**
 * The mailbox address from the id_token claims. The token comes straight from the provider's token
 * endpoint over TLS, so its payload is read without checking the signature (OIDC Core 3.1.3.7).
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const v = claims.email ?? claims.preferred_username ?? claims.upn;
    return typeof v === "string" ? v.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}
