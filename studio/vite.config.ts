import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // cwd 非依存の絶対パス (vite の root は cwd 相対のため。レビュー反映)
  root: fileURLToPath(new URL("frontend", import.meta.url)),
  plugins: [svelte()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true, // 占有時はエラー終了 (Vite 側のみ。backend の EADDRINUSE は 1a 既知ギャップ)
    proxy: {
      // 同一 origin 化により backend は CORS 不要 (Phase 1a 申し送り②の解)
      "/api": "http://127.0.0.1:7787",
    },
  },
});
