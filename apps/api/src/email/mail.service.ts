import { Injectable } from "@nestjs/common";
import type { mailboxes } from "@orbyt/db";
import { ImapFlow } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import { assertPublicUrl } from "../ssrf";
import { decryptJson } from "./secrets";

export type MailboxRow = typeof mailboxes.$inferSelect;
export const CREDENTIALS_UNREADABLE =
  "Stored credentials could not be decrypted. Was ORBYT_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) changed? Re-enter the mailbox password.";
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

@Injectable()
export class MailService {
  credentials(mailbox: MailboxRow): Credentials {
    return decryptJson<Credentials>(mailbox.credentialsEnc);
  }

  /** Mailbox hosts are user-supplied, so they get the same SSRF guard as webhook URLs. */
  async assertHostAllowed(host: string) {
    await assertPublicUrl(`http://${host}`);
  }

  private smtp(mailbox: MailboxRow) {
    return nodemailer.createTransport({
      host: mailbox.smtpHost,
      port: mailbox.smtpPort,
      secure: mailbox.smtpSecure,
      auth: {
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
      transport = this.smtp(mailbox);
    } catch {
      // Unreadable stored credentials: park the mailbox ("auth"), do not retry the contact forever.
      throw new SendError(CREDENTIALS_UNREADABLE, "auth");
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
      transport = this.smtp(mailbox);
    } catch {
      return { smtp: CREDENTIALS_UNREADABLE, imap: CREDENTIALS_UNREADABLE };
    }
    try {
      await transport.verify();
    } catch (err) {
      result.smtp = (err as Error).message;
    } finally {
      transport.close();
    }
    const imap = this.imap(mailbox);
    try {
      await imap.connect();
    } catch (err) {
      result.imap = (err as Error).message;
    } finally {
      await imap.logout().catch(() => undefined);
    }
    return result;
  }

  imap(mailbox: MailboxRow) {
    const client = new ImapFlow({
      host: mailbox.imapHost,
      port: mailbox.imapPort,
      secure: mailbox.imapSecure,
      auth: {
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
