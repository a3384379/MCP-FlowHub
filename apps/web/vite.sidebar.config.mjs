import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    license: true,
    outDir: fileURLToPath(new URL("../../web-dist/mcp-app", import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./src/codex/sidebar.ts", import.meta.url)),
      name: "FlowHubSidebar",
      formats: ["iife"],
      fileName: () => "sidebar.js",
    },
  },
});
