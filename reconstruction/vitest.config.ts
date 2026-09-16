import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["reconstruction/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
