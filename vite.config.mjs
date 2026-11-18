import { defineConfig } from "vite";
const localApi = "http://127.0.0.1:18473";
export default defineConfig({
  root: "apps/web",
  build: { outDir: "../../web-dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: localApi,
        configure(proxy) {
          proxy.on("proxyReq", (outgoing, incoming) => {
            // Translate only the exact same-origin browser request to the dev server.
            const host = `127.0.0.1:${incoming.socket.localPort}`;
            if (incoming.socket.localAddress !== "127.0.0.1" || incoming.headers.host !== host) return;
            outgoing.setHeader("Host", new URL(localApi).host);
            if (incoming.headers.origin === `http://${host}`) {
              outgoing.setHeader("Origin", localApi);
            }
          });
        },
      },
    },
  },
});
