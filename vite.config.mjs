import { defineConfig } from "vite";
export default defineConfig({
  root: "apps/web",
  build: { outDir: "../../web-dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:18473" } },
});
