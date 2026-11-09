import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  // 프로젝트 루트(../)의 .env 파일 로드
  const env = loadEnv(mode, path.resolve(__dirname, ".."), "");
  const frontendHost = process.env.FRONTEND_HOST || env.FRONTEND_HOST || "0.0.0.0";
  const frontendPort = Number(process.env.FRONTEND_PORT || env.FRONTEND_PORT || env.VITE_PORT || 9000);
  const backendUrl = process.env.BACKEND_URL || env.BACKEND_URL || "http://127.0.0.1:8001";

  return {
    plugins: [react()],
    server: {
      host: frontendHost,
      port: frontendPort,
      allowedHosts: true,
      proxy: {
        "/api": {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
