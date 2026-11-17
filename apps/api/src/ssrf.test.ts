import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateAddress } from "./ssrf";

describe("SSRF guard", () => {
  const saved = process.env.ORBYT_ALLOW_PRIVATE_URLS;
  beforeEach(() => delete process.env.ORBYT_ALLOW_PRIVATE_URLS);
  afterEach(() => {
    if (saved === undefined) delete process.env.ORBYT_ALLOW_PRIVATE_URLS;
    else process.env.ORBYT_ALLOW_PRIVATE_URLS = saved;
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "not-an-ip",
  ])("treats %s as private", (addr) => {
    expect(isPrivateAddress(addr)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"])(
    "treats %s as public",
    (addr) => {
      expect(isPrivateAddress(addr)).toBe(false);
    },
  );

  it("rejects bad schemes, private literals and names that resolve privately", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(assertPublicUrl("ftp://example.com")).rejects.toThrow(/http/);
    await expect(assertPublicUrl("nonsense")).rejects.toThrow(/Invalid URL/);
    await expect(assertPublicUrl("http://127.0.0.1:3000/x")).rejects.toThrow(
      /private/,
    );
    await expect(assertPublicUrl("http://[::1]/x")).rejects.toThrow(/private/);
    await expect(
      assertPublicUrl("http://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow(/private/);
    await expect(assertPublicUrl("http://localhost:8080")).rejects.toThrow(
      /private/,
    );
  });

  it("allows public literals, and anything when explicitly enabled", async () => {
    await expect(
      assertPublicUrl("https://93.184.216.34/hook"),
    ).resolves.toBeInstanceOf(URL);
    process.env.ORBYT_ALLOW_PRIVATE_URLS = "true";
    await expect(assertPublicUrl("http://127.0.0.1/x")).resolves.toBeInstanceOf(
      URL,
    );
  });
});
