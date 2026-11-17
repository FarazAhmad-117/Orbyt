import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyLicense } from "./license";

const script = resolve(__dirname, "../../../../scripts/license.mjs");
const run = (...args: string[]) =>
  execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
  }).trim();

describe("scripts/license.mjs", () => {
  it("generates a key pair and signs licenses the API accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbyt-license-"));
    run("keygen", dir);
    const publicPem = readFileSync(join(dir, "license-public.pem"), "utf8");
    const key = run(
      "sign",
      "--key",
      join(dir, "license-private.pem"),
      "--sub",
      "Acme Agency",
      "--features",
      "sso,audit_logs",
      "--days",
      "30",
      "--max-workspaces",
      "25",
    );
    const r = verifyLicense(key, publicPem);
    expect(r).toMatchObject({
      ok: true,
      payload: {
        sub: "Acme Agency",
        features: ["sso", "audit_logs"],
        maxWorkspaces: 25,
      },
    });
    // 30 days from now, give or take a minute.
    const exp = (r as { payload: { exp: number } }).payload.exp;
    expect(Math.abs(exp - (Date.now() / 1000 + 30 * 86400))).toBeLessThan(60);

    // A different installation's public key rejects it.
    const other = mkdtempSync(join(tmpdir(), "orbyt-license-"));
    run("keygen", other);
    expect(
      verifyLicense(
        key,
        readFileSync(join(other, "license-public.pem"), "utf8"),
      ).ok,
    ).toBe(false);
  });

  it("refuses unknown features, missing arguments and bad durations", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbyt-license-"));
    run("keygen", dir);
    const key = join(dir, "license-private.pem");
    const fails = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    const bad = fails(
      "sign",
      "--key",
      key,
      "--sub",
      "x",
      "--days",
      "1",
      "--features",
      "sso,teleport",
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("teleport");
    expect(fails("sign", "--key", key).status).toBe(1);
    expect(
      fails("sign", "--key", key, "--sub", "x", "--days", "-5").status,
    ).toBe(1);
    expect(fails("nonsense").status).toBe(1);
  });
});
