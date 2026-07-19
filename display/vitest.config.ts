import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

export default defineConfig({
  // svelteTesting() が browser condition と auto-cleanup を正しく設定する
  // (studio/vitest.config.ts と同じ理由で resolve.conditions の手書きは避ける)
  plugins: [svelte(), svelteTesting()],
  test: {
    globals: true,
    include: ["frontend/src/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: ["frontend/src/test-setup.ts"],
  },
});
