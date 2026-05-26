import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: projectRoot,
  cacheDir: "node_modules/.vite-test",
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    environmentOptions: {
      jsdom: {
        url: "http://localhost/"
      }
    },
    globals: true
  }
});
