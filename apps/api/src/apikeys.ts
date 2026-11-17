import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "orbyt_";

/** Only this hash is stored; the raw key is shown once at creation. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateApiKey() {
  const raw = API_KEY_PREFIX + randomBytes(24).toString("base64url");
  return { raw, prefix: raw.slice(0, 12), hash: hashApiKey(raw) };
}
