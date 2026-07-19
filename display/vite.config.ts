import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // cwd 非依存の絶対パス (vite の root は cwd 相対のため。studio/vite.config.ts 参照)
  root: fileURLToPath(new URL("frontend", import.meta.url)),
  base: "./",
  plugins: [svelte()],
  build: {
    outDir: fileURLToPath(new URL("dist", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("frontend/index.html", import.meta.url)),
        preview: fileURLToPath(new URL("frontend/preview.html", import.meta.url)),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/events": "http://127.0.0.1:7788",
      "/healthz": "http://127.0.0.1:7788",
      "/tips": "http://127.0.0.1:7788",
    },
  },
});
