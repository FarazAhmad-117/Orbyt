// Same-origin proxy to the Orbyt API: the browser only ever talks to this origin, so session
// cookies stay first-party and there is no CORS to configure. The target is read at REQUEST time
// (not build time) so one published image works for any deployment.
const API_URL = () => process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3001";

async function proxy(req: Request): Promise<Response> {
  const { pathname, search } = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL()}${pathname}${search}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // Required by Node's fetch when streaming a request body.
      duplex: "half",
      redirect: "manual",
      cache: "no-store",
    } as RequestInit);
  } catch {
    return Response.json({ message: "API unavailable" }, { status: 502 });
  }
  const out = new Headers(upstream.headers);
  // fetch() already decoded the body, so these would now be wrong.
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
