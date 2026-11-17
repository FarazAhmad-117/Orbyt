import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// True for loopback / private / link-local / CGNAT / multicast / reserved addresses.
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      a >= 224
    );
  }
  if (kind === 6) {
    const v = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      v === "::" ||
      v === "::1" ||
      v.startsWith("fc") ||
      v.startsWith("fd") ||
      v.startsWith("fe8") ||
      v.startsWith("fe9") ||
      v.startsWith("fea") ||
      v.startsWith("feb") ||
      v.startsWith("ff")
    );
  }
  return true; // not an IP at all: refuse
}

/**
 * SSRF guard for user-supplied URLs (webhooks, HTTP node): http(s) only, and the host must not
 * resolve to a private address. Set ORBYT_ALLOW_PRIVATE_URLS=true to allow (local dev / tests).
 * shortcut: DNS is resolved here and again by fetch(), so a rebinding host could slip through;
 * pin the resolved IP with an undici dispatcher when this guards anything high-risk.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only http(s) URLs are allowed");
  if (process.env.ORBYT_ALLOW_PRIVATE_URLS === "true") return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (
    addresses.length === 0 ||
    addresses.some((a) => isPrivateAddress(a.address))
  )
    throw new Error("URL resolves to a private or reserved address");
  return url;
}
