/**
 * [Antigravity-Doc]
 * 파일 역할: AutoCoinTrade 프론트엔드의 Vite 개발 서버 및 프로덕션 번들 빌드 설정 파일입니다.
 * 구성 요소:
 *   - @vitejs/plugin-react: JSX 변환 및 React Fast Refresh(HMR) 지원
 *   - 프로젝트 루트(../)의 .env 환경변수 로드 및 포트/백엔드 프록시 설정
 *   - 개발 서버 /api -> 백엔드 API 서버 프록시 구성
 * 수정 시 주의사항:
 *   - 보안을 위해 기본 devHost는 127.0.0.1(루프백)으로 제한되어 있습니다. 외부 노출이 필요한 경우에만
 *     VITE_DEV_HOST 환경변수를 명시적으로 지정하세요.
 *   - 프로덕션 환경에서는 이 개발 서버 대신 frontend/server.mjs가 dist/ 정적 파일 및 /api 프록시를 담당합니다.
 */
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

// [Antigravity-Doc] ESM 환경에서 현재 파일(frontend/vite.config.js)의 디렉터리 경로를 안전하게 계산 (Node 20.11+ import.meta.dirname 우선 사용)
const CURRENT_DIR = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

// [Antigravity-Doc] 실행 모드(development/production)에 따라 동적으로 Vite 설정 객체를 반환
export default defineConfig(({ mode }) => {
  // [Antigravity-Doc] prefix를 빈 문자열("")로 지정하여 VITE_ 접두사가 없는 루트 .env 변수(FRONTEND_PORT, BACKEND_URL 등)까지 모두 로드
  // 프로젝트 루트(../)의 .env 파일 로드
  const env = loadEnv(mode, path.resolve(CURRENT_DIR, ".."), "");
  // [Antigravity-Doc] 개발 서버 바인딩 호스트: 미지정 시 로컬 루프백(127.0.0.1) 고정
  // Vite 개발 서버는 로컬 루프백(127.0.0.1)만 허용 (외부 원격 노출 방지)
  const devHost = process.env.VITE_DEV_HOST || "127.0.0.1";
  // [Antigravity-Doc] 프론트엔드 개발 서버 포트 우선순위: OS 환경변수 FRONTEND_PORT > .env FRONTEND_PORT > .env VITE_PORT > 기본값 9000
  const frontendPort = Number(process.env.FRONTEND_PORT || env.FRONTEND_PORT || env.VITE_PORT || 9000);
  // [Antigravity-Doc] 개발 중 /api 요청을 포워딩할 백엔드 서버 주소 (기본값: http://127.0.0.1:8001)
  const backendUrl = process.env.BACKEND_URL || env.BACKEND_URL || "http://127.0.0.1:8001";

  return {
    // [Antigravity-Doc] React JSX 컴파일 및 HMR 플러그인 활성화
    plugins: [react()],
    server: {
      host: devHost,
      port: frontendPort,
      // [Antigravity-Doc] 브라우저 CORS 문제를 회피하기 위해 /api 경로를 백엔드로 프록시 전달 (changeOrigin: Host 헤더를 백엔드 대상으로 변환)
      proxy: {
        "/api": {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
