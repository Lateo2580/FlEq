import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "backend",
          globals: true,
          include: ["backend/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./backend/tests/setup.ts"],
        },
      },
      {
        // svelteTesting() が browser condition と auto-cleanup を正しく設定する。
        // 手書きの resolve.conditions: ["browser"] は Vite 6+ でデフォルト条件を
        // **置換** してしまい他依存の解決を壊すため使わない (レビュー反映)
        plugins: [svelte(), svelteTesting()],
        test: {
          name: "frontend",
          globals: true,
          include: ["frontend/src/**/*.test.ts"],
          environment: "jsdom",
        },
      },
    ],
  },
});
