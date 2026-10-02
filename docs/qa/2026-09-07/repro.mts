/**
 * Audit probes only. Imports the existing implementation; patches nothing.
 * Uses synthetic upstream responses and in-memory databases, with no network.
 * Run from repository root:
 * node --import ./apps/core/node_modules/tsx/dist/loader.mjs docs/qa/2026-09-07/repro.mts
 * FAIL means an expected user-facing invariant is violated, not a harness crash.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { CanvasRestClient } from '../../../apps/core/src/canvas/client.ts';
import { LearningXReadClient } from '../../../apps/core/src/learningx/client.ts';
import { LectureClient } from '../../../apps/core/src/lecture/client.ts';
import { createCanvasMcpServer } from '../../../apps/core/src/mcp/server.ts';
import { CanvasMessageService } from '../../../apps/core/src/canvas/messages.ts';
import { openDatabase } from '../../../apps/core/src/db/index.ts';
import { createFileDownloadLink, verifyFileDownloadToken } from '../../../apps/core/src/fileLinks.ts';
import { Client } from '../../../apps/core/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../apps/core/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';

const connection = { userId: 'qa-user', institution: 'hanyang' as const, baseUrl: 'https://learning.hanyang.ac.kr', accessToken: 'synthetic-QA-credential', canvasUserId: '42', canvasName: 'QA' };
const window = { startAt: '2026-09-07T00:00:00+09:00', endAt: '2026-09-14T00:00:00+09:00' };
const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);
const client = (handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) => new CanvasRestClient(connection, { fetch: async (url, init) => handler(new URL(String(url)), init) });
const planner = (id: number, submissions: unknown, extra = {}) => ({ course_id: 7, plannable_id: id, plannable_type: 'assignment', plannable_date: '2026-09-08T00:00:00Z', plannable: { id, title: 'QA assignment' }, submissions, ...extra });
const results: Array<{ id: string; category: string; name: string; status: string; detail?: string }> = [];
async function probe(id: string, category: string, name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ id, category, name, status: 'PASS' }); }
  catch (e) { results.push({ id, category, name, status: 'FAIL', detail: e instanceof Error ? e.message : String(e) }); }
  const r = results.at(-1)!; console.log(`${r.status} ${id}: ${name}${r.detail ? ` — ${r.detail.split('\n').slice(0, 3).join(' ')}` : ''}`);
}

await probe('P01', 'correctness', 'Planner boolean submitted is not unsubmitted', async () => {
  const c = client(() => json([planner(1, { submitted: true, graded: false, missing: false, needs_grading: true })]));
  const result = await c.getUpcomingWork({ ...window, includeCompleted: true });
  assert.equal(result[0].submissionStatus, 'submitted');
});
await probe('P02', 'correctness', 'Planner graded boolean is preserved', async () => {
  const c = client(() => json([planner(1, { graded: true, missing: false })]));
  assert.equal((await c.getUpcomingWork({ ...window, includeCompleted: true }))[0].submissionStatus, 'graded');
});
await probe('P03', 'completeness', 'Completed first page must not hide an incomplete second page', async () => {
  const c = client(url => url.searchParams.has('page')
    ? json([planner(2, { workflow_state: 'unsubmitted' })])
    : json([planner(1, { workflow_state: 'submitted' })], { headers: { link: '<https://learning.hanyang.ac.kr/api/v1/planner/items?page=2>; rel="next"' } }));
  assert.equal((await c.getUpcomingWork({ ...window, limit: 1 }))[0]?.id, '2');
});
await probe('P04', 'completeness', 'Module children omitted by upstream are not reported as an empty module', async () => {
  const c = client(url => url.pathname.endsWith('/items') ? json([{ id: 2, title: 'A real file', type: 'File', content_id: 3 }]) : json([{ id: 1, name: 'Large module', items_count: 150, items_url: 'https://learning.hanyang.ac.kr/api/v1/courses/7/modules/1/items' }]));
  const result = await c.listModules(7, { includeItems: true });
  assert.ok(result[0].items.length > 0 || (result[0] as any).itemsComplete === false, 'items=[] with no incomplete marker despite items_count=150');
});
await probe('P05', 'resilience', 'Weekly summary retains successful sections when announcements fail', async () => {
  const c = client(url => url.pathname.endsWith('/announcements') ? json({ message: 'Denied' }, { status: 403 }) : url.pathname.endsWith('/courses') ? json([{ id: 7, name: 'QA course' }]) : json([]));
  const result = await c.weeklySummary({ ...window, courseIds: ['7'] });
  assert.equal(result.courses[0]?.id, '7');
});
await probe('P06', 'completeness', 'Selecting a course should happen before a global course limit', async () => {
  const c = client(url => url.pathname.endsWith('/courses')
    ? (url.searchParams.has('page') ? json([{ id: 8, name: 'Requested course' }]) : json([{ id: 7, name: 'Other course' }], { headers: { link: '<https://learning.hanyang.ac.kr/api/v1/courses?page=2>; rel="next"' } }))
    : json([]));
  const result = await c.weeklySummary({ ...window, courseIds: ['8'], limitPerCollection: 1 });
  assert.equal(result.courses[0]?.id, '8');
});

function lx(payload: unknown, tabs = [{ id: 'context_external_tool_138', label: 'Lecture/Attendance' }]) {
  const calls: string[] = [];
  const c = new LearningXReadClient(connection, { fetch: async (input) => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    if (url.pathname.endsWith('/tabs')) return json(tabs);
    if (url.pathname.endsWith('/sessionless_launch')) return json({ url: 'https://lti.xinics.com/verifier' });
    if (url.href === 'https://lti.xinics.com/verifier') return new Response('<form action="https://lti.xinics.com/launch"><input name="oauth" value="synthetic"></form>');
    if (url.href === 'https://lti.xinics.com/launch') return new Response('', { status: 302, headers: { 'set-cookie': 'xn_api_token=aaa.bbb.ccc; Secure' } });
    if (url.pathname.endsWith('/profile')) return json({ id: 42 });
    return json(payload);
  } });
  return { c, calls };
}
await probe('P07', 'resilience', 'LearningX changed response shape must not become a successful empty list', async () => {
  const { c } = lx({ items: [{ id: 9, title: 'Existing lecture' }] });
  let rejected = false;
  try { const r = await c.listAttendance(7); assert.ok(r.length > 0, 'valid JSON object with records silently becomes []'); }
  catch (e) { if ((e as any).code === 'invalid_response') rejected = true; else throw e; }
  void rejected;
});
await probe('P08', 'routing', 'Ambiguous attendance tabs must not silently select Offline Attendance', async () => {
  const { c, calls } = lx([], [{ id: 'context_external_tool_148', label: 'Offline Attendance' }, { id: 'context_external_tool_138', label: 'Lecture/Attendance' }]);
  try { await c.listAttendance(7); } catch (e) { if ((e as any).code === 'invalid_argument') return; throw e; }
  assert.ok(!calls.some(x => x.includes('sessionless_launch?id=148')), 'first regex match selected Offline Attendance');
});

async function withMcp(fn: (c: Client, list: any) => Promise<void>) {
  const lectureClient = new LectureClient({ baseUrl: 'https://lecture.example', serviceToken: 'synthetic-service-token-at-least-32-chars', fetch: async () => json({ sessions: [] }) });
  const s = createCanvasMcpServer({ userId: connection.userId, getConnection: () => connection, lectureClient, fetch: async () => json([]) });
  const c = new Client({ name: 'qa', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await s.connect(b); await c.connect(a);
  try { await fn(c, await c.listTools()); } finally { await c.close(); await s.close(); }
}
await probe('P09', 'contract', 'The declared daily recording course can be selected through MCP', async () => withMcp(async c => {
  const r = await c.callTool({ name: 'list_lecture_sessions', arguments: { course_id: 'daily' } });
  assert.notEqual(r.isError, true, 'daily is rejected at the MCP input boundary');
}));
await probe('P10', 'completeness', 'Historical recordings expose a continuation or date window', async () => withMcp(async (_c, list) => {
  const fields = list.tools.find((t: any) => t.name === 'list_lecture_sessions').inputSchema.properties;
  assert.ok(['cursor','before','before_at','end_at','offset','page'].some(k => k in fields), 'only course_id/status/limit are exposed; records beyond the cap cannot be enumerated');
}));

const lectureSummary = { id: 'qa-session', title: 'QA', courseId: 'daily', courseCode: 'daily', courseName: 'Daily', courseTerm: '', courseFolderName: 'daily', courseMatchStatus: 'daily', finalizationWarning: null, revision: 0, status: 'ready', startedAt: '2026-06-01T00:00:00Z', endedAt: '2026-06-01T00:10:00Z', durationMs: 600000, sourceLanguage: 'ko', targetLanguage: 'zh', models: { translation: 'gpt-5.4-mini', transcription: 'gpt-realtime-whisper' }, segmentCount: 1, savedAt: '2026-06-01T00:10:01Z', updatedAt: '2026-06-01T00:10:01Z' };
await probe('P11', 'compatibility', 'One historical model name must not break all recording summaries', async () => {
  const c = new LectureClient({ baseUrl: 'https://lecture.example', serviceToken: 'synthetic-service-token-at-least-32-chars', fetch: async () => json({ sessions: [lectureSummary, { ...lectureSummary, id: 'older', models: { ...lectureSummary.models, transcription: 'gpt-4o-transcribe' } }] }) });
  assert.ok((await c.listSessions()).sessions.some(s => s.id === 'qa-session'));
});
await probe('P12', 'sanitization', 'Encoded active URL is not returned as sanitized HTML', async () => {
  const c = client(() => json({ id: 1, name: 'QA', description: '<a href="jav&#x61;script:alert(1)">click</a>' }));
  const r = await c.getAssignment(7, 1);
  assert.ok(!r.descriptionHtml?.includes('jav&#x61;script:'), 'encoded javascript scheme survives the HTML regex');
});
await probe('P13', 'credential-boundary', 'Raw verifier links in course-authored HTML are not returned', async () => {
  const c = client(() => json({ id: 1, description: '<a href="https://learning.hanyang.ac.kr/files/7/download?verifier=SYNTHETIC_QA_ONLY">Notes</a>' }));
  assert.ok(!JSON.stringify(await c.getAssignment(7, 1)).includes('verifier='), 'course HTML bypasses the file relay credential boundary');
});
await probe('P14', 'error-contract', 'Upstream reflected credentials do not appear in public errors', async () => {
  const c = client(() => json({ message: `Rejected token ${connection.accessToken}` }, { status: 400 }));
  try { await c.listCourses(); assert.fail('expected rejection'); }
  catch (e) { assert.ok(!JSON.stringify((e as any).toJSON?.()).includes(connection.accessToken), 'synthetic credential was copied into public error.message'); }
});
await probe('P15', 'error-contract', 'Punctuation in a permission denial must not imply an expired credential', async () => {
  const c = client(url => url.pathname.endsWith('/profile') ? json({ id: 42, name: 'QA' }) : json({ errors: [{ message: '用户无权执行该操作。' }] }, { status: 401 }));
  assert.equal((await c.connectionStatus()).connected, true);
  try { await c.listFiles(7); assert.fail('expected denial'); }
  catch (e) { assert.notEqual((e as any).code, 'authentication_failed', 'only adding Chinese punctuation changed the diagnosis to authentication failure'); }
});

await probe('G01', 'guardrail', 'Invalid Canvas ID is rejected before network', async () => {
  let calls = 0; const c = client(() => { calls++; return json({}); });
  await assert.rejects(() => c.getCourse('../users/self'), { code: 'invalid_argument' }); assert.equal(calls, 0);
});
await probe('G02', 'guardrail', 'Pagination cannot send a PAT to another origin', async () => {
  let calls = 0; const c = client(() => { calls++; return json([{ id: 7 }], { headers: { link: '<https://example.invalid/api/v1/courses?page=2>; rel="next"' } }); });
  await assert.rejects(() => c.listCourses({ limit: 2 }), { code: 'unsafe_pagination' }); assert.equal(calls, 1);
});
await probe('G03', 'guardrail', 'Cyclic pagination is rejected', async () => {
  const c = client(url => json([{ id: 7 }], { headers: { link: `<${url}>; rel="next"` } }));
  await assert.rejects(() => c.listCourses({ limit: 10 }), { code: 'unsafe_pagination' });
});
await probe('G04', 'guardrail', 'Inbox GET explicitly preserves unread state', async () => {
  const c = client(url => { assert.equal(url.searchParams.get('auto_mark_as_read'), 'false'); return json({ id: 8, messages: [] }); }); await c.getConversation(8);
});
await probe('G05', 'guardrail', 'Invalid date window is rejected before network', async () => {
  let calls = 0; const c = client(() => { calls++; return json([]); });
  await assert.rejects(() => c.getUpcomingWork({ startAt: window.endAt, endAt: window.startAt }), { code: 'invalid_argument' }); assert.equal(calls, 0);
});
await probe('G06', 'guardrail', 'Missing grade stays null rather than zero', async () => {
  const c = client(() => json({ id: 1, workflow_state: 'submitted', score: null, grade: null }));
  const r = await c.getSubmissionStatus(7, 1); assert.equal(r.score, null); assert.equal(r.status, 'submitted');
});
await probe('G07', 'guardrail', 'File capability expires at its boundary', () => {
  const masterKey = Buffer.alloc(32, 9), now = 1900000000000;
  const link = createFileDownloadLink({ publicOrigin: 'https://study.example', masterKey, userId: 'qa', fileId: '7', now, ttlSeconds: 60 });
  const token = new URL(link.uri).pathname.split('/').at(-1)!;
  assert.ok(verifyFileDownloadToken({ token, masterKey, now }));
  assert.equal(verifyFileDownloadToken({ token, masterKey, now: now + 60000 }), null);
});
await probe('G08', 'guardrail', 'Concurrent identical sends issue at most one synthetic POST', async () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare("INSERT INTO users(id,display_name,institution,created_at,updated_at) VALUES('qa-user','QA','hanyang',1,1)").run();
    let posts = 0;
    const service = new CanvasMessageService(db, () => connection, async (_url, init) => {
      if (init?.method === 'POST') { posts++; return json([{ id: 9 }]); }
      return json({ id: 7, teachers: [{ id: 8, display_name: 'QA Teacher' }] });
    });
    const input = { request_id: '00000000-0000-4000-8000-000000000001', course_id: '7', recipient_id: '8', subject: 'Synthetic', body: 'Synthetic' };
    const results = await Promise.allSettled([service.deliver('qa-user', 'send', input), service.deliver('qa-user', 'send', input)]);
    assert.equal(posts, 1); assert.ok(results.some(r => r.status === 'fulfilled'));
    await service.deliver('qa-user', 'send', input); assert.equal(posts, 1);
  } finally { db.close(); }
});

const summary = { timestamp: new Date().toISOString(), cases: results.length, passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, network: 'none; every upstream call is mocked', results };
writeFileSync(new URL('./probe-results.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ cases: summary.cases, passed: summary.passed, failed: summary.failed }));
process.exitCode = summary.failed ? 1 : 0;
