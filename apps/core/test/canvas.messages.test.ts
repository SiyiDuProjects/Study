import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase, type AppDatabase } from "../src/db/index.js";
import { CanvasMessageService } from "../src/canvas/messages.js";
import { createCanvasMcpServer } from "../src/mcp/server.js";
import type { CanvasConnection } from "../src/domain.js";

const connection: CanvasConnection = {userId:"u",institution:"hanyang",baseUrl:"https://learning.hanyang.ac.kr",accessToken:"test-only-pat",canvasUserId:"42",canvasName:"Student"};
const input = {request_id:"00000000-0000-4000-8000-000000000001",course_id:"123",recipient_id:"7",subject:"Question",body:"A course question"};
const databases: AppDatabase[] = [];
afterEach(() => databases.splice(0).forEach(db=>db.close()));
function setup(post: (init?: RequestInit)=>Promise<Response> = async()=>Response.json([{id:99}])) {
  const db = openDatabase(":memory:"); databases.push(db);
  db.prepare("INSERT INTO users(id,display_name,institution,created_at,updated_at) VALUES('u','Student','hanyang',1,1)").run();
  const fetcher = vi.fn<typeof fetch>(async(url,init)=> {
    if(init?.method === "POST") return post(init);
    if(String(url).includes("conversations")) {
      expect(String(url)).toContain("auto_mark_as_read=false");
      return Response.json({id:99,participants:[{id:7,name:"Teacher"},{id:42,name:"Student"}],messages:[]});
    }
    return Response.json({id:123,name:"Course",teachers:[{id:7,display_name:"Teacher"}]});
  });
  return {db,fetcher,service:new CanvasMessageService(db,()=>connection,fetcher)};
}
describe("explicit Canvas message delivery",()=>{
  it("sends once and returns the persisted receipt on retry, without storing message text",async()=>{
    const {db,fetcher,service}=setup(async init=>{
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(String(init?.body))).toMatchObject({recipients:["7"],force_new:true,group_conversation:false});
      return Response.json([{id:99}]);
    });
    expect(await service.deliver("u","send",input)).toMatchObject({status:"sent",conversationIds:["99"]});
    await service.deliver("u","send",input);
    expect(fetcher.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1);
    expect(JSON.stringify(db.prepare("SELECT * FROM canvas_message_receipts").all())).not.toContain(input.body);
    await expect(service.deliver("u","send",{...input,body:"changed"})).rejects.toThrow("different content");
  });
  it("blocks unverified recipients and self",async()=>{
    const {service,fetcher}=setup();
    await expect(service.deliver("u","send",{...input,recipient_id:"8"})).rejects.toThrow("verified teacher");
    await expect(service.deliver("u","send",{...input,recipient_id:"42"})).rejects.toThrow("yourself");
    expect(fetcher.mock.calls.some(([,i])=>i?.method==="POST")).toBe(false);
  });
  it("claims concurrent identical requests before issuing one POST",async()=>{
    const {service,fetcher}=setup();
    const results=await Promise.allSettled([
      service.deliver("u","send",input),
      service.deliver("u","send",input),
    ]);
    expect(results.some(result=>result.status==="fulfilled")).toBe(true);
    expect(fetcher.mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(1);
    await service.deliver("u","send",input);
    expect(fetcher.mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(1);
  });
  it("replies only to the selected existing participant without marking read",async()=>{
    const {service}=setup(async init=>{
      expect(JSON.parse(String(init?.body))).toEqual({recipients:["7"],body:input.body});
      return Response.json({id:99});
    });
    await service.deliver("u","reply",{request_id:input.request_id,recipient_id:"7",conversation_id:"99",body:input.body});
  });
  it.each(["transport","redirect","invalid response"])("does not resend after %s uncertainty",async mode=>{
    const {service,fetcher,db}=setup(async()=>{
      if(mode==="transport") throw new Error("secret provider diagnostics");
      return mode==="redirect" ? new Response(null,{status:302,headers:{Location:"https://other.test"}}) : Response.json({unexpected:true});
    });
    await expect(service.deliver("u","send",input)).rejects.toThrow(/inspect Sent/i);
    await expect(service.deliver("u","send",input)).rejects.toThrow("unknown");
    expect(fetcher.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1);
    expect((db.prepare("SELECT status FROM canvas_message_receipts").get() as {status:string}).status).toBe("unknown");
  });
  it("publishes write annotations with the shared Study authorization",async()=>{
    const {service,fetcher}=setup();
    const server=createCanvasMcpServer({userId:"u",getConnection:()=>connection,fetch:fetcher,messageService:service});
    const client=new Client({name:"test",version:"1"});
    const [a,b]=InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a),client.connect(b)]);
    try {
      const list=await client.listTools();
      for(const name of ["send_message","reply_message"]){
        const tool=list.tools.find(t=>t.name===name);
        expect(tool?.annotations).toMatchObject({readOnlyHint:false,destructiveHint:true,openWorldHint:true});
        expect(tool?._meta?.securitySchemes).toEqual([{type:"oauth2",scopes:["canvas.read"]}]);
      }
      expect(fetcher).not.toHaveBeenCalled();
    } finally {await client.close();await server.close();}
  });
});
