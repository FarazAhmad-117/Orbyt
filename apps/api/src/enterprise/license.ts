import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * Offline license keys: `base64url(payload JSON) + "." + base64url(Ed25519 signature)`.
 * Verified against the PUBLIC key in ORBYT_LICENSE_PUBLIC_KEY (PEM) or the file named by
 * ORBYT_LICENSE_PUBLIC_KEY_FILE. With no public key configured no license is ever valid, so a
 * community install can never be tricked into enabling paid features. Keys are signed with
 * `scripts/license.mjs` (the private key stays with the vendor).
 */
export interface LicensePayload {
  sub: string; // who it was issued to
  features: string[];
  maxWorkspaces?: number;
  maxMailboxes?: number;
  exp: number; // unix seconds
}
export type LicenseResult =
  { ok: true; payload: LicensePayload } | { ok: false; reason: string };

export function publicKeyFromEnv(): string | null {
  const inline = process.env.ORBYT_LICENSE_PUBLIC_KEY;
  if (inline) return inline.replace(/\\n/g, "\n");
  const file = process.env.ORBYT_LICENSE_PUBLIC_KEY_FILE;
  if (file && existsSync(file)) return readFileSync(file, "utf8");
  return null;
}

export function verifyLicense(
  key: string,
  publicKeyPem: string | null,
  nowMs = Date.now(),
): LicenseResult {
  if (!publicKeyPem)
    return { ok: false, reason: "No license public key configured" };
  const [body, sig, ...rest] = key.trim().split(".");
  if (!body || !sig || rest.length)
    return { ok: false, reason: "Malformed license key" };
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(body, "base64url"),
      createPublicKey(publicKeyPem),
      Buffer.from(sig, "base64url"),
    );
  } catch {
    return { ok: false, reason: "Invalid license public key or signature" };
  }
  if (!valid) return { ok: false, reason: "Signature does not match" };
  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "Malformed license payload" };
  }
  if (
    typeof payload.exp !== "number" ||
    !Array.isArray(payload.features) ||
    typeof payload.sub !== "string"
  )
    return { ok: false, reason: "Malformed license payload" };
  if (payload.exp * 1000 < nowMs)
    return { ok: false, reason: "License expired" };
  return { ok: true, payload };
}
