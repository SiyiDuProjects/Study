import { writeFileSync } from 'node:fs';
import { CanvasRestClient } from '../../../apps/core/src/canvas/client.ts';
import { LearningXReadClient } from '../../../apps/core/src/learningx/client.ts';
import { canvasToolOutputSchemas } from '../../../apps/core/src/mcp/canvasOutputSchemas.ts';
import { sanitizeHtml } from '../../../apps/core/src/content.ts';
import { createCanvasMcpServer } from '../../../apps/core/src/mcp/server.ts';
import { Client } from '../../../apps/core/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../apps/core/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';

// Synthetic fixtures only. This script never uses credentials or real network I/O.
const connection = { userId: 'audit', institution: 'hanyang' as const,
  baseUrl: 'https://learning.hanyang.ac.kr', accessToken: 'synthetic-audit-value-only',
  canvasUserId: '42', canvasName: 'Synthetic student' };
const rows: Array<{id:string; safetyExpectation:string; passed:boolean; observed:unknown}> = [];
const record = (id:string, safetyExpectation:string, passed:boolean, observed:unknown) => rows.push({id,safetyExpectation,passed,observed});
const client = (value:unknown) => new CanvasRestClient(connection, { fetch: async () => Response.json(value) });
const window = {startAt:'2026-09-01T00:00:00+09:00',endAt:'2026-09-30T23:59:59+09:00'};
const planner = (submissions:unknown, override?:unknown) => [{plannable_id:8,course_id:7,plannable_type:'assignment',
  plannable_date:'2026-09-20T14:59:00Z',plannable:{id:8,title:'Synthetic missing assignment',due_at:'2026-09-20T14:59:00Z'},
  submissions,planner_override:override}];
const gradedMissing = {graded:true,missing:true,submitted:false,excused:false};
const defaultWork = await client(planner(gradedMissing)).getUpcomingWork(window);
record('P01','Default work discovery must retain graded + missing work',defaultWork.items.length===1,defaultWork);
const allWork = await client(planner(gradedMissing)).getUpcomingWork({...window,includeCompleted:true});
record('P02','Missing work must not be classified completed even when included',allWork.items[0]?.completed!==true,allWork);
const submission = await client({id:9,assignment_id:8,user_id:42,workflow_state:'graded',missing:true,score:0,submitted_at:null}).getSubmissionStatus(7,8);
record('C01','Authoritative submission preserves graded + missing + zero',submission.status==='missing'&&submission.score===0,submission);
const marked = await client(planner({submitted:false,missing:true},{marked_complete:true})).getUpcomingWork({...window,includeCompleted:true});
record('P03','Expose planner override separately so manual completion is distinguishable',Object.hasOwn(marked.items[0]??{},'plannerOverride'),marked);
const locked = await client({id:8,course_id:7,name:'Locked',lock_at:null,locked_for_user:true,lock_info:{manually_locked:true},lock_explanation:'Module prerequisite',allowed_attempts:1,
  submission:{id:9,workflow_state:'unsubmitted',attempt:1}}).getAssignment(7,8);
record('P04','Preserve authoritative user lock and allowed attempt facts',Object.hasOwn(locked,'lockedForUser')&&Object.hasOwn(locked,'allowedAttempts'),locked);
const redo = await client({id:9,assignment_id:8,user_id:42,workflow_state:'graded',submitted_at:'2026-09-19T00:00:00Z',grade:'0',score:0,redo_request:true}).getSubmissionStatus(7,8);
record('P05','Preserve teacher resubmission request',Object.hasOwn(redo,'redoRequest'),redo);
const emptySubmission = await client({}).getSubmissionStatus(7,8);
const emptyAccepted = canvasToolOutputSchemas.get_submission_status.safeParse({ok:true,result:emptySubmission,error:null}).success;
record('P06','Malformed empty submission must not pass as confirmed unsubmitted',!emptyAccepted,{schemaAccepted:emptyAccepted,result:emptySubmission});
const wrongAssignment = await client({id:999,course_id:666,name:'Wrong course'}).getAssignment(7,8);
record('P07','Reject detail response for a different assignment/course',wrongAssignment.id==='8'&&wrongAssignment.courseId==='7',wrongAssignment);
const wrongSubmission = await client({id:9,assignment_id:999,user_id:777,workflow_state:'submitted',submitted_at:'2026-09-19T00:00:00Z'}).getSubmissionStatus(7,8);
record('P08','Reject submission detail identifying another assignment or student',wrongSubmission.assignmentId!=='8',{requested:{assignment:8,user:42},upstream:{assignment:999,user:777},result:wrongSubmission});
const malformedList = await client([{}]).listAssignments(7);
const listAccepted = canvasToolOutputSchemas.list_assignments.safeParse({ok:true,result:malformedList,error:null}).success;
record('P09','Reject assignment list rows without a valid ID',!listAccepted,{schemaAccepted:listAccepted,result:malformedList});
const link = sanitizeHtml('<p>Required survey <a href="https://school.example/view?id=27">form</a></p>');
record('P10','Preserve non-secret query parameters required to locate a resource',link?.includes('id=27')===true,link);
const embedded = sanitizeHtml('<p>Required instructions:</p><iframe src="https://learning.hanyang.ac.kr/courses/7/files/123/preview"></iframe>');
record('P11','Keep a safe reference or omission warning for embedded instruction files',embedded?.includes('123')===true||embedded?.includes('omitted')===true,embedded);
const nullGrades = await client([{id:4,course_id:7,grades:{current_score:null,final_score:null}}]).getGrades();
record('C02','Unknown score remains null, never zero',nullGrades.items[0]?.currentScore===null&&nullGrades.items[0]?.finalScore===null,nullGrades);
let calls=0;
const twoPages=new CanvasRestClient(connection,{fetch:async input=>{calls++;const u=new URL(String(input));return u.searchParams.get('page')==='2'
  ? Response.json([{id:2,name:'Second'}]) : Response.json([{id:1,name:'First'}],{headers:{Link:'<https://learning.hanyang.ac.kr/api/v1/courses/7/assignments?page=2>; rel="next"'}});}});
const page1=await twoPages.listAssignments(7,{limit:1});
const page2=await twoPages.listAssignments(7,{limit:1,cursor:page1.nextCursor!});
record('C03','Assignments remain discoverable across continuation',page1.items[0]?.id==='1'&&page2.items[0]?.id==='2'&&page2.nextCursor===null,{first:page1.items.map(x=>x.id),second:page2.items.map(x=>x.id),calls});
let blocked=false;
try {await twoPages.listAssignments(8,{limit:1,cursor:page1.nextCursor!});}catch{blocked=true;}
record('C04','Reject cursor replay into another course',blocked,{blocked});
const lxFetch:typeof fetch=async(input)=>{const u=new URL(String(input));
  if(u.pathname.endsWith('/sessionless_launch'))return Response.json({url:'https://lti.xinics.com/verifier'});
  if(u.pathname==='/verifier')return new Response('<form action="https://lti.xinics.com/launch"><input name="synthetic" value="safe"></form>');
  if(u.pathname==='/launch')return new Response('',{status:302,headers:{'set-cookie':'xn_api_token=aaa.bbb.ccc; Secure'}});
  if(u.pathname.endsWith('/attendance_items'))return Response.json({attendance_items:[{id:8,course_id:7,use_attendance:true}]});
  if(u.pathname.endsWith('/attendance_items/summary'))return Response.json({attendance_summaries:{}});
  throw new Error('Unmocked route');};
const lx=await new LearningXReadClient(connection,{fetch:lxFetch}).listAttendance(7,132);
record('C05','Unknown attendance is not classified absent or incomplete',lx[0]?.attendanceStatus===null&&lx[0]?.completed===null,lx);
const server=createCanvasMcpServer({userId:connection.userId,getConnection:()=>connection,
  fetch:async input=>new URL(String(input)).pathname==='/api/v1/planner/items'?Response.json(planner(gradedMissing)):Response.json({})});
const mcp=new Client({name:'synthetic-safety-audit',version:'1'});
const [a,b]=InMemoryTransport.createLinkedPair();
await server.connect(a); await mcp.connect(b);
try {
  const missingMcp=await mcp.callTool({name:'get_upcoming_work',arguments:{start_at:window.startAt,end_at:window.endAt}});
  const missingEnvelope=missingMcp.structuredContent as any;
  record('P12','Real MCP tools/call retains missing work',missingEnvelope?.result?.items?.length===1,missingMcp.structuredContent);
  const emptyMcp=await mcp.callTool({name:'get_submission_status',arguments:{course_id:7,assignment_id:8}});
  record('P13','Real MCP tools/call rejects malformed submission',emptyMcp.isError===true,emptyMcp.structuredContent);
  const invalidDate=await mcp.callTool({name:'get_upcoming_work',arguments:{start_at:'2026-09-21T00:00:00',end_at:window.endAt}});
  record('C06','Public tool rejects datetime without timezone offset',invalidDate.isError===true,{isError:invalidDate.isError});
} finally {await mcp.close();await server.close();}
let denied=false;
try {await new CanvasRestClient(connection,{fetch:async()=>Response.json({errors:[{message:'denied'}]},{status:403})}).listAssignments(7);} catch(e:any){denied=e.code==='permission_denied';}
record('C07','Permission failure never becomes empty coursework',denied,{denied});
const announcementWork=await client([{plannable_id:10,course_id:7,plannable_type:'announcement',plannable_date:'2026-09-06T06:52:12Z',plannable:{id:10,title:'Class change for September 21'},submissions:false}]).getUpcomingWork({...window,includeCompleted:true});
record('P14','Announcement publication date must not become an invented deadline',announcementWork.items[0]?.dueAt===null,announcementWork);
const report={synthetic:true,schoolNetworkCalls:0,generatedAt:new Date().toISOString(),passed:rows.filter(x=>x.passed).length,failed:rows.filter(x=>!x.passed).length,probes:rows};
writeFileSync(new URL('./probe-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
