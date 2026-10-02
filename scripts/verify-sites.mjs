import assert from "node:assert/strict";

const baseUrl = process.env.STUDY_RECORD_URL || process.env.LECTURE_API_URL;
const sitesToken = process.env.LECTURE_SITE_AUTH_TOKEN;
const serviceToken = process.env.LECTURE_SERVICE_TOKEN;
if (!baseUrl || !sitesToken || !serviceToken) throw new Error("Record URL and both server-side service credentials are required");
const base = new URL(baseUrl);
assert.equal(base.protocol, "https:");
const headers = { "OAI-Sites-Authorization": `Bearer ${sitesToken}`, Authorization: `Bearer ${serviceToken}`, Accept: "application/json", "X-Study-Lecture-Contract": "paged-v1" };
async function get(path) {
  const response = await fetch(new URL(path, base), { headers, redirect: "error" });
  if (!response.ok) throw new Error(`Record read returned ${response.status}`);
  return response.json();
}
async function pages(path, detail = false) {
  const result = { items: [], warnings: [], pageCount: 0 };
  const cursors = new Set();
  let cursor;
  do {
    const page = await get(path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
    assert(Array.isArray(page.items) && Array.isArray(page.warnings));
    assert(page.nextCursor === null || typeof page.nextCursor === "string");
    if (detail) assert(page.session && typeof page.rangeComplete === "boolean");
    result.items.push(...page.items); result.warnings.push(...page.warnings); result.pageCount++;
    cursor = page.nextCursor;
    if (cursor) { assert(!cursors.has(cursor) && result.pageCount < 1000, "Cursor failed to advance"); cursors.add(cursor); }
  } while (cursor);
  return result;
}
const list = await pages("/internal/mcp/lecture/sessions?status=all&limit=2");
assert(list.items.length > 0, "Expected saved recordings");
assert.equal(new Set(list.items.map(x => x.id)).size, list.items.length);
let segmentCount = 0, detailPages = 0, warningCount = list.warnings.length, searchText = "";
for (const session of list.items) {
  const detail = await pages(`/internal/mcp/lecture/sessions/${encodeURIComponent(session.id)}?limit=2`, true);
  assert.equal(new Set(detail.items.map(x => x.id)).size, detail.items.length);
  assert.equal(detail.items.length + detail.warnings.length, session.segmentCount);
  segmentCount += detail.items.length; detailPages += detail.pageCount; warningCount += detail.warnings.length;
  searchText ||= detail.items.map(x => String(x.translatedText || x.sourceText || "").trim()).find(Boolean) || "";
}
assert(searchText, "Expected searchable text");
const search = await pages(`/internal/mcp/lecture/search?q=${encodeURIComponent(searchText.slice(0, 3))}&status=all&limit=2`);
assert(search.items.length > 0);
const legacyHeaders = { ...headers };
delete legacyHeaders["X-Study-Lecture-Contract"];
async function legacy(path) {
  const response = await fetch(new URL(path, base), { headers: legacyHeaders, redirect: "error" });
  assert.equal(response.status, 200);
  return response.json();
}
const legacyList = await legacy("/internal/mcp/lecture/sessions?status=all&limit=100");
assert.equal(legacyList.sessions.length, list.items.length);
const legacyDetail = await legacy(`/internal/mcp/lecture/sessions/${encodeURIComponent(list.items[0].id)}`);
assert.equal(legacyDetail.session.segments.length, list.items[0].segmentCount);
const legacySearch = await legacy(`/internal/mcp/lecture/search?q=${encodeURIComponent(searchText.slice(0, 3))}&status=all&limit=2`);
assert(Array.isArray(legacySearch.hits) && legacySearch.hits.length > 0);
const outerOnly = { "OAI-Sites-Authorization": `Bearer ${sitesToken}` };
const denied = await fetch(new URL("/api/sessions", base), { headers: outerOnly, redirect: "error" });
assert([401, 403].includes(denied.status), "Anonymous browser data must be denied");
const deniedService = await fetch(new URL("/internal/mcp/lecture/sessions", base), { headers: outerOnly, redirect: "error" });
assert([401, 403].includes(deniedService.status), "Missing internal service token must be denied");
console.log(JSON.stringify({ sessions: list.items.length, listPages: list.pageCount, segments: segmentCount, detailPages, warnings: warningCount, searchHits: search.items.length, legacyListDetailSearch: "passed", browserWithoutIdentityStatus: denied.status, missingServiceTokenStatus: deniedService.status }));
