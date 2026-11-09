import json
import logging
import os
import sys
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from agentBot.bot_manager import bot_orchestrator
from backend.common.database import db_manager
from backend.common.upbit_client import upbit_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("autoCoinTrade.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Upbit Auto Coin Trading Server...")
    db_manager.initialize_schema()
    bot_orchestrator.start_background_worker()
    yield
    logger.info("Shutting down Upbit Auto Coin Trading Server...")
    bot_orchestrator.stop_background_worker()


app = FastAPI(
    title="Upbit Multi-Strategy Auto Coin Trade API",
    version="1.0.0",
    lifespan=lifespan,
)

allowed_origins_env = os.getenv("ALLOWED_ORIGINS")
allowed_origins = [o.strip() for o in allowed_origins_env.split(",") if o.strip()] if allowed_origins_env else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=".*",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


@app.middleware("http")
async def ensure_cors_headers(request: Request, call_next):
    origin = request.headers.get("origin") or "*"
    if request.method == "OPTIONS":
        return Response(
            status_code=200,
            headers={
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Max-Age": "86400",
            },
        )
    try:
        response = await call_next(request)
    except Exception as exc:
        logger.error("Unhandled request error: %s", exc)
        response = JSONResponse(
            status_code=500,
            content={"detail": str(exc)},
        )
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, PATCH"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response


# ------------------------------------------------------------------
# Request / Response Schemas
# ------------------------------------------------------------------
class EntryCodeRequest(BaseModel):
    code: str


class BotUpdateRequest(BaseModel):
    nickname: str = Field(..., min_length=1)
    min_volume_krw: int = Field(..., ge=0)
    stop_loss_pct: float = Field(..., gt=0)
    take_profit_pct: float = Field(..., gt=0)
    config: Dict[str, Any] = Field(default_factory=dict)


class AllocationUpdateRequest(BaseModel):
    total_capital: float
    ratios: Dict[str, float]


class ManualTradeRequest(BaseModel):
    action: str = "buy"
    market: str = "KRW-BTC"


# ------------------------------------------------------------------
# 1. 입장 코드 인증 (기본: stock)
# ------------------------------------------------------------------
@app.post("/api/auth/verify")
def verify_entry_code(payload: EntryCodeRequest):
    expected_code = db_manager.get_setting("entry_code", "stock")
    if payload.code == expected_code:
        return {"authenticated": True, "message": "인증 성공"}
    return JSONResponse(
        status_code=401,
        content={"authenticated": False, "message": "입장 코드가 일치하지 않습니다."},
    )


# ------------------------------------------------------------------
# 2. 업비트 통신 상태 확인 (요구사항 19: 초록/노랑/빨강 + 사유 툴팁)
# ------------------------------------------------------------------
@app.get("/api/upbit/status")
def get_upbit_connection_status():
    return upbit_client.check_connection_status()


@app.get("/api/upbit/account")
def get_upbit_account_balance():
    return upbit_client.get_krw_account_balance()


# ------------------------------------------------------------------
# 3. 시스템 및 봇 상태 / 거래 시작·중단 / 잔고 0 이하 체크 (요구사항 15, 20, 21, 22)
# ------------------------------------------------------------------
@app.get("/api/system/overview")
def get_system_overview():
    halt_info = db_manager.check_and_halt_if_zero_balance()
    settings = db_manager.get_all_settings()
    bots = db_manager.get_bots()
    return {
        "total_capital": int(float(settings.get("total_capital", "0"))),
        "zero_balance_halted": halt_info["halted"],
        "zero_balance_reason": halt_info["reason"],
        "stats_start_date": settings.get("stats_start_date", "2026-10-01"),
        "bots": bots,
    }


@app.get("/api/bots")
def list_bots():
    halt_info = db_manager.check_and_halt_if_zero_balance()
    return {
        "bots": db_manager.get_bots(),
        "zero_balance_halted": halt_info["halted"],
        "zero_balance_reason": halt_info["reason"],
    }


@app.post("/api/bots/{bot_id}/start")
def start_bot(bot_id: str):
    result = db_manager.set_bot_running(bot_id, is_running=True)
    return result


@app.post("/api/bots/{bot_id}/stop")
def stop_bot(bot_id: str):
    result = db_manager.set_bot_running(bot_id, is_running=False)
    return result


@app.put("/api/bots/{bot_id}")
def update_bot(bot_id: str, payload: BotUpdateRequest):
    updated = db_manager.update_bot_settings(
        bot_id=bot_id,
        nickname=payload.nickname,
        min_volume_krw=payload.min_volume_krw,
        stop_loss_pct=payload.stop_loss_pct,
        take_profit_pct=payload.take_profit_pct,
        config=payload.config,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="봇을 찾을 수 없습니다.")
    return {
        "success": True,
        "message": f"[{updated['nickname']}] 봇 설정 및 별명이 저장되었습니다.",
        "bot": updated,
    }


@app.post("/api/bots/{bot_id}/manual-trade")
def trigger_manual_trade(bot_id: str, payload: ManualTradeRequest):
    return bot_orchestrator.execute_manual_test_trade(
        bot_id=bot_id,
        action=payload.action,
        market=payload.market,
    )


# ------------------------------------------------------------------
# 4. 거래현황 게시판 조회 (요구사항 9: 봇별 탭, 매수/매도/매수일/매도일/차익 1줄 표기)
# ------------------------------------------------------------------
@app.get("/api/trades")
def list_trades(bot_id: Optional[str] = Query(default=None)):
    halt_info = db_manager.check_and_halt_if_zero_balance()
    trades = db_manager.get_trades_by_bot(bot_id=bot_id)
    return {
        "trades": trades,
        "zero_balance_halted": halt_info["halted"],
        "zero_balance_reason": halt_info["reason"],
    }


# ------------------------------------------------------------------
# 5. 통계 조회 (요구사항 10, 11, 12: 2026.10.01부터 일간/주간/월간 선그래프 + 다빈도 코인 손익)
# ------------------------------------------------------------------
@app.get("/api/statistics")
def get_statistics():
    return db_manager.get_statistics(start_date="2026-10-01")


# ------------------------------------------------------------------
# 6. 설정: 자금 분배 비율(소수점 버림) 및 JSON 마이그레이션/복원 (요구사항 13, 21, 22)
# ------------------------------------------------------------------
@app.put("/api/settings/allocation")
def update_capital_allocation(payload: AllocationUpdateRequest):
    ratio_sum = round(sum(float(v) for v in payload.ratios.values()), 2)
    if ratio_sum > 100.0:
        raise HTTPException(
            status_code=400,
            detail=f"봇별 자금 분배 비율의 합계({ratio_sum}%)는 100%를 초과할 수 없습니다.",
        )

    floored_total = math.floor(float(payload.total_capital or 0))
    account_info = upbit_client.get_krw_account_balance()
    max_asset_limit = int(account_info.get("total_asset_krw") or account_info.get("krw_balance") or 0)
    if not account_info.get("success") or account_info.get("total_asset_krw") is None:
        raise HTTPException(
            status_code=400,
            detail=f"업비트 총 보유 자산을 조회할 수 없어 전체 운용 원금을 저장할 수 없습니다. ({account_info.get('message', '실계좌 조회 실패')})",
        )
    if floored_total > max_asset_limit:
        raise HTTPException(
            status_code=400,
            detail=f"설정하려는 전체 운용 원금({floored_total:,}원)이 업비트 총 보유 자산({max_asset_limit:,}원)의 한도를 초과하여 저장할 수 없습니다.",
        )

    bots = db_manager.update_capital_allocations(
        total_capital=payload.total_capital,
        ratios=payload.ratios,
    )
    halt_info = db_manager.check_and_halt_if_zero_balance()
    return {
        "success": True,
        "message": "자금 분배 비율 및 원금 설정이 저장되었습니다 (소수점 이하 버림 적용).",
        "total_capital": int(float(db_manager.get_setting("total_capital", "0"))),
        "bots": bots,
        "zero_balance_halted": halt_info["halted"],
        "zero_balance_reason": halt_info["reason"],
    }


@app.get("/api/settings/export")
def export_migration_json():
    data = db_manager.export_all_to_dict()
    filename = f"autoCoinTrade_migration_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    return JSONResponse(
        content=data,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@app.post("/api/settings/import")
async def import_migration_json(file: UploadFile = File(...)):
    try:
        raw_bytes = await file.read()
        payload = json.loads(raw_bytes.decode("utf-8"))
        summary = db_manager.import_all_from_dict(payload)
        return {
            "success": True,
            "message": (
                f"데이터 복원이 완료되었습니다 "
                f"(봇 {summary['restored_bots']}개, 거래내역 {summary['restored_trades']}건, 포지션 {summary['restored_positions']}건)."
            ),
            "summary": summary,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"JSON 복원 실패: {exc}")


@app.post("/api/settings/import-json")
def import_migration_json_body(payload: Dict[str, Any]):
    try:
        summary = db_manager.import_all_from_dict(payload)
        return {
            "success": True,
            "message": (
                f"데이터 복원이 완료되었습니다 "
                f"(봇 {summary['restored_bots']}개, 거래내역 {summary['restored_trades']}건, 포지션 {summary['restored_positions']}건)."
            ),
            "summary": summary,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"JSON 복원 실패: {exc}")


# ------------------------------------------------------------------
# 정적 프론트엔드 서빙 (빌드 산출물이 있을 경우 로컬 웹 통합 제공)
# ------------------------------------------------------------------
FRONTEND_DIST = BASE_DIR / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        target = FRONTEND_DIST / full_path
        if target.is_file():
            return FileResponse(str(target))
        index_file = FRONTEND_DIST / "index.html"
        if index_file.is_file():
            return FileResponse(str(index_file))
        return JSONResponse({"status": "Backend running"})

