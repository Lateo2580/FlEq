import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

/**
 * The Phase 6B production gate imports both the engine and a live Svelte
 * component in the same test process. Keep that chain out of root Vitest,
 * which intentionally has no Svelte transform or jsdom environment.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [svelte(), svelteTesting()],
  server: {
    fs: { allow: [".."] },
  },
  test: {
    globals: true,
    include: ["../test/engine/telegram-foundation/phase6b-legacy-card-production.test.ts"],
    environment: "jsdom",
    setupFiles: ["../test/setup.ts", "frontend/src/test-setup.ts"],
    env: { TZ: "Asia/Tokyo" },
  },
});
