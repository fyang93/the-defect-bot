import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/.direnv/**", "**/node_modules/**"],
    fileParallelism: false,
    testTimeout: 20000,
    setupFiles: [path.join(rootDir, "tests", "support", "vitest.setup.ts")],
  },
  resolve: {
    alias: [
      { find: "bun:test", replacement: path.join(rootDir, "tests", "support", "bun-test-shim.ts") },
      { find: /^bot\/(.*)$/, replacement: path.join(rootDir, "src", "bot", "$1") },
      { find: /^cli\/(.*)$/, replacement: path.join(rootDir, "src", "cli", "$1") },
    ],
  },
});
