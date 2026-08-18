import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: projectRoot,
  cacheDir: "node_modules/.vite",
  plugins: [react()],
  optimizeDeps: {
    noDiscovery: true,
    include: []
  },
  server: {
    host: "127.0.0.1",
    fs: {
      allow: [projectRoot]
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true
      }
    }
  }
});
