import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCanvasTools, type CanvasMcpDependencies } from "./canvasTools.js";
import { registerLectureTools } from "./lectureTools.js";
import type { LectureClient } from "../lecture/index.js";

export interface StudyMcpDependencies extends CanvasMcpDependencies {
  lectureClient?: LectureClient;
}

/** Create one stateless, authenticated-user-bound MCP server instance. */
export function createCanvasMcpServer(dependencies: StudyMcpDependencies): McpServer {
  const server = new McpServer({
    name: "canvas-readonly",
    version: "0.1.0",
  });
  registerCanvasTools(server, dependencies);
  if (dependencies.lectureClient) {
    registerLectureTools(server, dependencies.lectureClient);
  }
  return server;
}
