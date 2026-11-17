import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // 프로젝트 루트(../)의 .env 파일 로드
  const env = loadEnv(mode, path.resolve(CURRENT_DIR, ".."), "");
  // Vite 개발 서버는 로컬 루프백(127.0.0.1)만 허용 (외부 원격 노출 방지)
  const devHost = process.env.VITE_DEV_HOST || "127.0.0.1";
  const frontendPort = Number(process.env.FRONTEND_PORT || env.FRONTEND_PORT || env.VITE_PORT || 9000);
  const backendUrl = process.env.BACKEND_URL || env.BACKEND_URL || "http://127.0.0.1:8001";

  return {
    plugins: [react()],
    server: {
      host: devHost,
      port: frontendPort,
      proxy: {
        "/api": {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
