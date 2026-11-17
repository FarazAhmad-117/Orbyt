import { describe, expect, it } from "vitest";
import {
  CREDENTIALS_UNREADABLE,
  MailService,
  SendError,
  type MailboxRow,
} from "./mail.service";

// A mailbox whose stored credentials cannot be decrypted (e.g. the encryption key was changed).
const broken = {
  id: "m1",
  email: "a@example.com",
  displayName: null,
  smtpHost: "127.0.0.1",
  smtpPort: 1,
  smtpSecure: false,
  smtpUser: "a",
  imapHost: "127.0.0.1",
  imapPort: 1,
  imapSecure: false,
  imapUser: "a",
  credentialsEnc: "not-a-valid-ciphertext",
} as unknown as MailboxRow;

describe("unreadable mailbox credentials", () => {
  const mail = new MailService();

  it("send() fails as an auth error so the mailbox is parked", async () => {
    const err = await mail
      .send({
        mailbox: broken,
        to: "b@example.com",
        subject: "s",
        text: "t",
        html: "t",
        messageId: "x",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err.kind).toBe("auth");
    expect(err.message).toBe(CREDENTIALS_UNREADABLE);
  });

  it("verify() reports the problem instead of throwing", async () => {
    const r = await mail.verify(broken);
    expect(r).toEqual({
      smtp: CREDENTIALS_UNREADABLE,
      imap: CREDENTIALS_UNREADABLE,
    });
  });
});
