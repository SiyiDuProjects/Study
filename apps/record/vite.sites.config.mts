import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const placeholderDatabaseId = "00000000-0000-4000-8000-000000000000";
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    root: projectRoot,
    cacheDir: "node_modules/.vite-sites",
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      react(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "server" },
        config: {
          name: "jiahuan-class-subtitles",
          main: "./worker/index.ts",
          compatibility_date: "2026-05-22",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: hostingConfig.d1
            ? [
                {
                  binding: hostingConfig.d1,
                  database_name: "jiahuan-sites-local",
                  database_id: placeholderDatabaseId
                }
              ]
            : [],
          assets: {
            binding: "ASSETS",
            not_found_handling: "single-page-application",
            run_worker_first: ["/api/*"]
          }
        }
      })
    ],
    optimizeDeps: {
      noDiscovery: true,
      include: ["lucide-react", "react", "react-dom", "react-dom/client"]
    }
  };
});
