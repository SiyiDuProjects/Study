import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

// Runs the built production module in workerd with an ephemeral D1 database.
// Does not read .env/.dev.vars, call OpenAI/Study, or touch persistent user data.
const serviceToken = "synthetic-local-smoke-token-00000000000000";
const mf = new Miniflare({
  modules: true,
  scriptPath: "dist/server/index.js",
  compatibilityDate: "2026-05-22",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: "lecture-smoke-test" },
  bindings: { LECTURE_SERVICE_TOKEN: serviceToken, STUDY_OWNER_EMAIL: "owner@example.invalid" },
});

try {
  const db = await mf.getD1Database("DB");
  for (const name of ["0000_funny_rictor.sql", "0001_study_record.sql", "0002_school_captions.sql"]) {
    const migration = await readFile(`drizzle/${name}`, "utf8");
    for (const sql of migration.split("--> statement-breakpoint")) {
      if (sql.trim()) await db.prepare(sql).run();
    }
  }
  await db.prepare(`INSERT INTO sessions (
    id,title,course_id,course_code,course_name,course_term,course_folder_name,
    started_at,ended_at,duration_ms,source_language,target_language,
    translation_model,transcription_model,saved_at,updated_at,status,course_match_status
  ) VALUES ('historical','Smoke','daily','','Daily','','Daily',
    '2026-09-01T00:00:00.000Z','2026-09-01T01:00:00.000Z',3600000,'ko','zh',
    'historical-translation','gpt-4o-mini-transcribe','2026-09-01T01:00:00.000Z',
    '2026-09-01T01:00:00.000Z','ready','daily')`).run();
  const longText = "한".repeat(40000);
  await db.batch(Array.from({ length: 12 }, (_, index) => db.prepare(`INSERT INTO transcript_segments
    (session_id,id,position,commit_sequence,started_at_ms,source_text,translated_text,is_final,created_at,updated_at)
    VALUES ('historical',?,?,?,?,?,?,1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`)
    .bind(`segment_${index}`, index, index, index * 1000, longText, longText)));
  const request = (path, authenticated = true) => mf.dispatchFetch(`http://record.test${path}`, {
    headers: authenticated ? { Authorization: `Bearer ${serviceToken}`, "X-Study-Lecture-Contract": "paged-v1" } : {},
  });
  assert.equal((await request("/api/health", false)).status, 200);
  assert.equal((await request("/internal/mcp/lecture/sessions", false)).status, 401);
  const listed = await (await request("/internal/mcp/lecture/sessions?course_id=daily")).json();
  assert.equal(listed.items[0].models.transcription, "gpt-4o-mini-transcribe");
  const segmentIds = new Set();
  let cursor = null;
  let pageCount = 0;
  do {
    const response = await request(`/internal/mcp/lecture/sessions/historical?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(Buffer.byteLength(body) < 900_000);
    const page = JSON.parse(body);
    for (const item of page.items) segmentIds.add(item.id);
    cursor = page.nextCursor;
    pageCount += 1;
    assert.ok(pageCount < 20, "cursor must make progress");
  } while (cursor);
  assert.equal(segmentIds.size, 12);
  assert.ok(pageCount > 1);
  console.log(`Built Worker smoke passed: authentication, historical models, and ${pageCount} bounded D1 transcript pages.`);
} finally {
  await mf.dispose();
}
