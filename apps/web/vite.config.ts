import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// В контейнере API остаётся на хосте, поэтому адрес прокси задаётся через API_PROXY_TARGET.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:4000";
// Docker Desktop на Windows не передаёт события файловой системы внутрь контейнера,
// поэтому для dev-сервера включаем опрос каталогов вместо нативных watch-событий.
const usePolling = process.env.VITE_DEV_POLLING === "true";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    watch: usePolling ? { usePolling: true, interval: 250 } : undefined,
    proxy: {
      "/api": apiProxyTarget
    }
  }
});
