import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // Keep unit tests off the real database file.
      DATABASE_PATH: path.resolve(__dirname, ".test-data", "test.db"),
    },
  },
});
