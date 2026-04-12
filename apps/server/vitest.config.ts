import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@chresmus/protocol": path.resolve(
        __dirname,
        "../../packages/codex-protocol/dist/index.js",
      ),
      "@chresmus/api": path.resolve(
        __dirname,
        "../../packages/codex-api/dist/index.js",
      ),
      "@chresmus/unified-surface": path.resolve(
        __dirname,
        "../../packages/unified-surface/dist/index.js",
      ),
      "@chresmus/opencode-api": path.resolve(
        __dirname,
        "../../packages/opencode-api/dist/index.js",
      ),
    },
  },
});
