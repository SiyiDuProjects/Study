import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCanvasTools, type CanvasMcpDependencies } from "./canvasTools.js";
import { registerLectureTools } from "./lectureTools.js";
import type { LectureClient } from "../lecture/index.js";
import type { CanvasMessageService } from "../canvas/messages.js";
import { registerMessageTools } from "./messageTools.js";
import type { CanvasWriteService } from "../canvas/writes.js";
import { registerWriteTools } from "./writeTools.js";
import { registerStaticSkills, studyMcpInstructions } from "./staticSkills.js";
import { studySkillCatalog } from "./studySkillCatalog.generated.js";

export interface StudyMcpDependencies extends CanvasMcpDependencies {
  lectureClient?: LectureClient;
  messageService?: CanvasMessageService;
  writeService?: CanvasWriteService;
}

/** Create one stateless, authenticated-user-bound MCP server instance. */
export function createCanvasMcpServer(dependencies: StudyMcpDependencies): McpServer {
  const server = new McpServer({
    name: "study",
    version: "0.1.0",
  }, { instructions: studyMcpInstructions });
  registerStaticSkills(server, studySkillCatalog);
  registerCanvasTools(server, dependencies);
  if (dependencies.messageService) registerMessageTools(server, dependencies.messageService, dependencies.userId);
  if (dependencies.writeService) registerWriteTools(server, dependencies.writeService, dependencies.userId);
  if (dependencies.lectureClient) {
    registerLectureTools(server, dependencies.lectureClient);
  }
  return server;
}
