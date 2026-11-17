import { Injectable } from "@nestjs/common";
import type { mailboxes } from "@orbyt/db";
import { ImapFlow } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import { assertPublicUrl } from "../ssrf";
import { OAuthError, refreshAccessToken, type OAuthProvider } from "./oauth";
import { decryptJson } from "./secrets";

export type MailboxRow = typeof mailboxes.$inferSelect;
export const CREDENTIALS_UNREADABLE =
  "Stored credentials could not be decrypted. Was ORBYT_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) changed? Re-enter the mailbox password.";
/** Google/Microsoft mailboxes sign in with OAuth tokens; everything else (including unsaved rows) uses passwords. */
const isOAuthMailbox = (m: Pick<MailboxRow, "authType">) =>
  m.authType === "google" || m.authType === "microsoft";
export interface Credentials {
  smtpPass: string;
  imapPass: string;
}

export interface SendInput {
  mailbox: MailboxRow;
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string; // without angle brackets
  inReplyTo?: string | null;
  references?: string[];
  headers?: Record<string, string>;
}

/** permanent = the recipient/message was refused for good; auth = our login is broken; transient = retry. */
export class SendError extends Error {
  constructor(
    message: string,
    public readonly kind: "permanent" | "auth" | "transient",
  ) {
    super(message);
  }
}

/**
 * Why the stored login could not be turned into a usable one: unreadable credentials or a revoked
 * OAuth grant park the mailbox ("auth"); a provider outage while refreshing is just retried.
 */
export function loginFailure(err: unknown): {
  message: string;
  kind: "auth" | "transient";
} {
  if (err instanceof OAuthError)
    return {
      message: err.message,
      kind: err.kind === "transient" ? "transient" : "auth",
    };
  return { message: CREDENTIALS_UNREADABLE, kind: "auth" };
}

@Injectable()
export class MailService {
  // Access tokens live ~1h; refreshing on every send would hammer the provider.
  private readonly tokens = new Map<string, { token: string; exp: number }>();

  credentials(mailbox: MailboxRow): Credentials {
    return decryptJson<Credentials>(mailbox.credentialsEnc);
  }

  /** Mailbox hosts are user-supplied, so they get the same SSRF guard as webhook URLs. */
  async assertHostAllowed(host: string) {
    await assertPublicUrl(`http://${host}`);
  }

  /** A current OAuth access token for a Google/Microsoft mailbox (refreshed when about to expire). */
  private async accessToken(mailbox: MailboxRow): Promise<string> {
    const key = `${mailbox.id}:${mailbox.credentialsEnc.slice(-24)}`;
    const cached = this.tokens.get(key);
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
    const { refreshToken } = decryptJson<{ refreshToken: string }>(
      mailbox.credentialsEnc,
    );
    const fresh = await refreshAccessToken(
      mailbox.authType as OAuthProvider,
      refreshToken,
    );
    this.tokens.set(key, { token: fresh.accessToken, exp: fresh.expiresAt });
    return fresh.accessToken;
  }

  private async smtp(mailbox: MailboxRow) {
    return nodemailer.createTransport({
      host: mailbox.smtpHost,
      port: mailbox.smtpPort,
      secure: mailbox.smtpSecure,
      auth: isOAuthMailbox(mailbox)
        ? {
            type: "OAuth2",
            user: mailbox.smtpUser,
            accessToken: await this.accessToken(mailbox),
          }
        : {
            user: mailbox.smtpUser,
            pass: this.credentials(mailbox).smtpPass,
          },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(input: SendInput): Promise<void> {
    const { mailbox } = input;
    let transport: Transporter;
    try {
      transport = await this.smtp(mailbox);
    } catch (err) {
      const f = loginFailure(err);
      throw new SendError(f.message, f.kind);
    }
    try {
      await transport.sendMail({
        from: { name: mailbox.displayName ?? "", address: mailbox.email },
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        messageId: `<${input.messageId}>`,
        inReplyTo: input.inReplyTo ? `<${input.inReplyTo}>` : undefined,
        references: input.references?.map((r) => `<${r}>`),
        headers: input.headers,
      });
    } catch (err) {
      const e = err as {
        code?: string;
        responseCode?: number;
        message: string;
      };
      if (e.code === "EAUTH" || e.responseCode === 535)
        throw new SendError(e.message, "auth");
      // 5xx replies to RCPT/DATA (user unknown, mailbox disabled, policy block) will not get better.
      if (e.responseCode && e.responseCode >= 500 && e.responseCode < 600)
        throw new SendError(e.message, "permanent");
      throw new SendError(e.message, "transient");
    } finally {
      transport.close();
    }
  }

  /** Checks both logins. Returns an error message per protocol, or null when it works. */
  async verify(
    mailbox: MailboxRow,
  ): Promise<{ smtp: string | null; imap: string | null }> {
    const result = { smtp: null as string | null, imap: null as string | null };
    let transport: Transporter;
    try {
      transport = await this.smtp(mailbox);
    } catch (err) {
      const message = loginFailure(err).message;
      return { smtp: message, imap: message };
    }
    try {
      await transport.verify();
    } catch (err) {
      result.smtp = (err as Error).message;
    } finally {
      transport.close();
    }
    let imap: ImapFlow;
    try {
      imap = await this.imap(mailbox);
    } catch (err) {
      result.imap = loginFailure(err).message;
      return result;
    }
    try {
      await imap.connect();
    } catch (err) {
      result.imap = (err as Error).message;
    } finally {
      await imap.logout().catch(() => undefined);
    }
    return result;
  }

  async imap(mailbox: MailboxRow) {
    const client = new ImapFlow({
      host: mailbox.imapHost,
      port: mailbox.imapPort,
      secure: mailbox.imapSecure,
      auth: isOAuthMailbox(mailbox)
        ? {
            user: mailbox.imapUser,
            accessToken: await this.accessToken(mailbox),
          }
        : {
            user: mailbox.imapUser,
            pass: this.credentials(mailbox).imapPass,
          },
      logger: false,
      // Avoids an unhandled 'error' event taking the process down on a dropped connection.
      connectionTimeout: 10_000,
    });
    client.on("error", () => undefined);
    return client;
  }
}
