import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:10000",
        changeOrigin: true,
      },
      "/auth": {
        target: "http://localhost:10000",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://localhost:10000",
        changeOrigin: true,
        ws: true,  // ← proxies WebSocket too (needed for socket.io)
      },
    },
  },
});