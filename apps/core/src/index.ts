import "dotenv/config";
import { createApplication, closeHttpServer } from "./app.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";

const config = loadConfig();
const runtime = createApplication({ config });
const server = runtime.app.listen(config.port, "0.0.0.0", () => {
  log("info", "server_started", {
    port: config.port,
    publicOrigin: config.publicOrigin,
    mcpResource: config.oauthResource,
  });
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("info", "server_stopping", { signal });
  try {
    await closeHttpServer(server);
    runtime.close();
    log("info", "server_stopped");
    process.exitCode = 0;
  } catch (error) {
    log("error", "server_shutdown_failed", { error });
    process.exitCode = 1;
    server.closeAllConnections();
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
  log("error", "unhandled_rejection", { error });
});
process.on("uncaughtException", (error) => {
  log("error", "uncaught_exception", { error });
  void shutdown("uncaughtException");
});
