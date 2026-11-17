import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { requireEnv } from "../db.service";

// shortcut: when ORBYT_ENCRYPTION_KEY is unset the key is derived from BETTER_AUTH_SECRET, so
// rotating that secret would make stored mailbox passwords undecryptable. Production deployments
// should set ORBYT_ENCRYPTION_KEY (32 random bytes, base64). The "v1" prefix leaves room for key rotation.
function encryptionKey(): Buffer {
  const raw = process.env.ORBYT_ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32)
      throw new Error("ORBYT_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    return key;
  }
  return derive("credentials-v1");
}

function derive(info: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", requireEnv("BETTER_AUTH_SECRET"), "orbyt", info, 32),
  );
}

/** AES-256-GCM: returns `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return ["v1", iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptJson<T>(payload: string): T {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !data)
    throw new Error("Unsupported secret format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8")) as T;
}

const mac = (body: string) =>
  createHmac("sha256", derive("links-v1")).update(body).digest("base64url");

/** Tamper-proof token for public links (unsubscribe, open/click tracking). */
export function signToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function verifyToken<T extends Record<string, unknown>>(
  token: string,
): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = mac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
