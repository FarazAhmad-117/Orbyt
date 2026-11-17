import { Injectable } from "@nestjs/common";
import nodemailer from "nodemailer";

/**
 * Transactional email sent by Orbyt itself (team invitations). Off unless ORBYT_SMTP_URL is set
 * (e.g. smtp://user:pass@smtp.example.com:587); callers must work without it, because the invite
 * link is also returned to the inviter.
 */
@Injectable()
export class NotifyService {
  get enabled() {
    return !!process.env.ORBYT_SMTP_URL;
  }

  async send(to: string, subject: string, text: string): Promise<boolean> {
    const url = process.env.ORBYT_SMTP_URL;
    if (!url) return false;
    const transport = nodemailer.createTransport(url);
    try {
      await transport.sendMail({
        from: process.env.ORBYT_MAIL_FROM || "Orbyt <no-reply@localhost>",
        to,
        subject,
        text,
      });
      return true;
    } catch (err) {
      console.error("[notify]", err);
      return false;
    } finally {
      transport.close();
    }
  }
}
