import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

export const REST_ORIGIN = "http://127.0.0.1:8788";
export const VITE_ORIGIN = "http://127.0.0.1:5173";

export function rewriteViteProxyOrigin(origin: string | undefined): string | undefined {
  return origin === VITE_ORIGIN ? REST_ORIGIN : origin;
}

function restProxy(): ProxyOptions {
  return {
    target: REST_ORIGIN,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest, request) => {
        const origin = rewriteViteProxyOrigin(request.headers.origin);
        if (origin !== request.headers.origin && origin) proxyRequest.setHeader("origin", origin);
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": restProxy(),
      "/healthz": restProxy(),
    },
  },
});
