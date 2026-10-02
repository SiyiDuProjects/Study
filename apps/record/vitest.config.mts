import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: projectRoot,
  cacheDir: "node_modules/.vite-test",
  test: {
    setupFiles: ["src/test-setup.ts"],
    environment: "jsdom",
    globals: true,
    exclude: [...configDefaults.exclude, "dist/**", "dist-server/**", ".tsbuild/**"]
  }
});
