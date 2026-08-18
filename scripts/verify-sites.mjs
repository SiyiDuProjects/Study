const baseUrl = process.env.STUDY_RECORD_URL;
const sitesToken = process.env.LECTURE_SITE_AUTH_TOKEN;
const serviceToken = process.env.LECTURE_SERVICE_TOKEN;

if (!baseUrl || !sitesToken || !serviceToken) {
  throw new Error("STUDY_RECORD_URL, LECTURE_SITE_AUTH_TOKEN, and LECTURE_SERVICE_TOKEN are required");
}

const base = new URL(baseUrl);
const headers = {
  "OAI-Sites-Authorization": `Bearer ${sitesToken}`,
  Authorization: `Bearer ${serviceToken}`,
  Accept: "application/json"
};

async function get(path) {
  const response = await fetch(new URL(path, base), { headers, redirect: "error" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

const list = await get("/internal/mcp/lecture/sessions?status=ready&limit=20");
if (!Array.isArray(list.sessions) || list.sessions.length === 0) throw new Error("No migrated sessions found");
const detail = await get(`/internal/mcp/lecture/sessions/${encodeURIComponent(list.sessions[0].id)}`);
if (!Array.isArray(detail.session?.segments)) throw new Error("Session detail contract failed");
const source = detail.session.segments.find((segment) =>
  String(segment.translatedText || segment.sourceText || "").trim()
);
const query = String(source?.translatedText || source?.sourceText || "课堂").trim().slice(0, 3);
const search = await get(`/internal/mcp/lecture/search?q=${encodeURIComponent(query)}&status=ready&limit=20`);
const noIdentity = await fetch(new URL("/api/sessions", base), {
  headers: { "OAI-Sites-Authorization": `Bearer ${sitesToken}` },
  redirect: "error"
});

console.log(JSON.stringify({
  listCount: list.sessions.length,
  detailSegments: detail.session.segments.length,
  searchHits: Array.isArray(search.hits) ? search.hits.length : null,
  browserWithoutIdentityStatus: noIdentity.status
}));
