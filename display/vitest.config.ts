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
    // 時刻整形はローカル時刻に依存する (実運用の Pi も開発機も JST)。
    // TZ を固定しないと UTC の CI や国外の開発機で 9 時間ずれて落ちる
    env: { TZ: "Asia/Tokyo" },
  },
});
