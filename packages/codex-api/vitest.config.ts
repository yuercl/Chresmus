import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@chresmus/protocol": path.resolve(
        __dirname,
        "../codex-protocol/dist/index.js",
      ),
      "@chresmus/unified-surface": path.resolve(
        __dirname,
        "../unified-surface/dist/index.js",
      ),
    },
  },
});
