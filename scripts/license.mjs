#!/usr/bin/env node
// Orbyt license tool (for the vendor; customers only receive the printed key).
//
//   node scripts/license.mjs keygen [dir]
//       Creates license-private.pem (KEEP SECRET, never commit it) and license-public.pem in `dir`.
//       Ship the public key with the build (ORBYT_LICENSE_PUBLIC_KEY / _FILE); sign keys with the private one.
//
//   node scripts/license.mjs sign --key license-private.pem --sub "Acme Agency" \
//        --features sso,audit_logs,white_label --days 365 [--max-workspaces 50] [--max-mailboxes 200]
//       Prints a license key to give to the customer (ORBYT_LICENSE_KEY).
//
// Keys are Ed25519-signed and verified offline by the API (apps/api/src/enterprise/license.ts).
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FEATURES = ["sso", "audit_logs", "white_label"];
const [cmd, ...rest] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}
function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined)
      fail(`Bad argument near "${args[i] ?? ""}"`);
    out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}

if (cmd === "keygen") {
  const dir = rest[0] ?? ".";
  mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    join(dir, "license-private.pem"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, "license-public.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
  );
  console.log(
    `Wrote ${join(dir, "license-private.pem")} (secret) and ${join(dir, "license-public.pem")}`,
  );
} else if (cmd === "sign") {
  const f = flags(rest);
  if (!f.key || !f.sub || !f.days)
    fail(
      "Usage: sign --key <private.pem> --sub <name> --days <n> [--features a,b] [--max-workspaces n] [--max-mailboxes n]",
    );
  const features = (f.features ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = features.filter((x) => !FEATURES.includes(x));
  if (unknown.length)
    fail(
      `Unknown feature(s): ${unknown.join(", ")}. Known: ${FEATURES.join(", ")}`,
    );
  const days = Number(f.days);
  if (!Number.isFinite(days) || days <= 0)
    fail("--days must be a positive number");
  const payload = {
    sub: f.sub,
    features,
    exp: Math.floor(Date.now() / 1000) + Math.round(days * 86400),
    ...(f["max-workspaces"]
      ? { maxWorkspaces: Number(f["max-workspaces"]) }
      : {}),
    ...(f["max-mailboxes"] ? { maxMailboxes: Number(f["max-mailboxes"]) } : {}),
  };
  const json = JSON.stringify(payload);
  const signature = sign(
    null,
    Buffer.from(json),
    createPrivateKey(readFileSync(f.key)),
  );
  console.log(
    `${Buffer.from(json).toString("base64url")}.${signature.toString("base64url")}`,
  );
} else {
  fail(
    "Usage: license.mjs keygen [dir] | sign --key <private.pem> --sub <name> --days <n> [--features a,b]",
  );
}
