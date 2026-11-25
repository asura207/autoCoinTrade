/**
 * [Antigravity-Doc]
 * 파일 역할: AutoCoinTrade 프론트엔드 React SPA의 진입점(Entry Point) 파일입니다.
 * 구성 요소:
 *   - React / ReactDOM (React 18 createRoot API)
 *   - 최상위 루트 컴포넌트 App (./App.jsx)
 *   - 전역 디자인 시스템 및 레이아웃 스타일시트 (./styles.css)
 * 수정 시 주의사항:
 *   - index.html 내부의 <div id="root"> 요소 ID와 반드시 일치해야 합니다.
 *   - React.StrictMode는 개발 환경(dev)에서 부수효과 검증을 위해 컴포넌트/useEffect를 2회 실행하므로
 *     프로덕션 동작과 혼동하지 않도록 주의하세요.
 */
import React from "react";
import ReactDOM from "react-dom/client";
// [Antigravity-Doc] 대시보드 전체 라우팅·상태·탭 UI를 총괄하는 최상위 App 컴포넌트 로드
import App from "./App.jsx";
// [Antigravity-Doc] 전역 CSS 변수(:root), 다크 테마, 테이블·모달·반응형 스타일 로드
import "./styles.css";

// [Antigravity-Doc] HTML의 #root DOM 노드에 React 18 동시성 루트를 생성하고 StrictMode로 감싸 마운트
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
