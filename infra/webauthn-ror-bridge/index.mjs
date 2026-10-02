// Existing two legacy routes only. Keep their previous origins during migration.
const RELATED_ORIGINS = Object.freeze({
  "canvas.gaid.studio": ["https://study.siyidu.com"],
  "berkeley-canvas.gaid.studio": ["https://berkeley.siyidu.com", "https://study.siyidu.com"],
});
const HEADERS = Object.freeze({
  "Cache-Control": "public, max-age=300",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Content-Type": "application/json",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});
const json = (body, status, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
export function handleRequest(request) {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.pathname !== "/.well-known/webauthn" || url.search || url.hash) return json({ error: "not_found" }, 404);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });
  const origins = Object.hasOwn(RELATED_ORIGINS, url.hostname) ? RELATED_ORIGINS[url.hostname] : null;
  if (!origins) return json({ error: "not_found" }, 404);
  return request.method === "HEAD" ? new Response(null, { status: 200, headers: HEADERS }) : json({ origins }, 200);
}
export default { fetch: handleRequest };
