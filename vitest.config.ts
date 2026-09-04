import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["test/engine/telegram-foundation/phase6b-legacy-card-production.test.ts"],
    setupFiles: ["test/setup.ts"],
    // GitHub Actions (ubuntu-latest, 2 コア) では max-admissible fixture や 512 境界ループを回す
    // テストが 10〜27 秒かかり、既定 5 秒で timeout していた (2026-09-03〜04 に 6 件が連続赤)。
    // ハング検出は 30 秒でも十分効くので、ローカル・CI 共通で引き上げる
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
