import json
import logging
import math
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from typing import Any, Dict, List, Optional

from init_db import get_db_connection, PgConnectionWrapper

logger = logging.getLogger("autoCoinTrade.database")

BASE_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "auto_coin_trade.db"


class DatabaseManager:
    """
    PostgreSQL 데이터베이스 매니저 (SQLite 완전 대체)
    - 세션이 끊기거나 날짜(자정)가 바뀐 경우 자동으로 재접속하는 로직 포함 (요구사항 25)
    - 주문 전 가상 잔고(virtual_krw) 트랜잭션 락 지원 (요구사항 23)
    - 잔고 0 이하 시 전체 봇 거래 중지 및 알림 플래그 처리 (요구사항 21)
    - 봇별 자금 분배 비율 설정 및 소수점 버림(math.floor) 처리 (요구사항 22)
    - JSON 기반 데이터 마이그레이션(백업) 및 복원 지원 (요구사항 13)
    """

    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = Path(db_path)
        self._lock = threading.RLock()
        self._tx_lock = threading.RLock()
        self._conn: Optional[PgConnectionWrapper] = None
        self._connected_date: Optional[str] = None
        self.initialize_schema()

    def _connect(self) -> PgConnectionWrapper:
        conn = get_db_connection()
        self._connected_date = datetime.now().strftime("%Y-%m-%d")
        logger.info("PostgreSQL connected (date=%s)", self._connected_date)
        return conn

    def _is_connection_alive(self, conn: Optional[PgConnectionWrapper]) -> bool:
        if conn is None:
            return False
        try:
            conn.execute("SELECT 1;").fetchone()
            return True
        except Exception as exc:
            logger.warning("PostgreSQL session health check failed: %s", exc)
            return False

    def get_connection(self) -> PgConnectionWrapper:
        """
        세션이 끊겼거나 날짜가 변경된 경우(자정 경과) 자동으로 기존 세션을 닫고 재접속합니다.
        """
        with self._lock:
            today_str = datetime.now().strftime("%Y-%m-%d")
            need_reconnect = False
            reason = ""

            if self._conn is None:
                need_reconnect = True
                reason = "initial connection"
            elif self._connected_date != today_str:
                need_reconnect = True
                reason = f"date changed ({self._connected_date} -> {today_str})"
            elif not self._is_connection_alive(self._conn):
                need_reconnect = True
                reason = "session disconnected"

            if need_reconnect:
                if self._conn is not None:
                    try:
                        self._conn.close()
                    except Exception:
                        pass
                logger.info("Reconnecting SQLite session (%s)...", reason)
                self._conn = self._connect()

            return self._conn

    @contextmanager
    def transaction(self):
        """
        주문 전 가상 잔고(virtual_krw) 검증 및 차감, 포지션 기록을 위한 원자적 트랜잭션 락 컨텍스트
        """
        with self._tx_lock:
            conn = self.get_connection()
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
                conn.execute("COMMIT")
            except Exception:
                try:
                    conn.execute("ROLLBACK")
                except Exception:
                    pass
                raise

    def initialize_schema(self) -> None:
        conn = self.get_connection()
        with self._tx_lock:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS system_settings (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                    """
                )

                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS bots (
                        bot_id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        nickname TEXT NOT NULL,
                        strategy_type TEXT NOT NULL,
                        description TEXT NOT NULL,
                        allocation_ratio REAL NOT NULL DEFAULT 0,
                        allocated_capital INTEGER NOT NULL DEFAULT 0,
                        virtual_krw INTEGER NOT NULL DEFAULT 0,
                        is_running INTEGER NOT NULL DEFAULT 0,
                        min_volume_krw INTEGER NOT NULL DEFAULT 0,
                        stop_loss_pct REAL NOT NULL DEFAULT 0,
                        take_profit_pct REAL NOT NULL DEFAULT 0,
                        config_json TEXT NOT NULL DEFAULT '{}',
                        last_status_msg TEXT NOT NULL DEFAULT '대기 중',
                        updated_at TEXT NOT NULL
                    )
                    """
                )

                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS trades (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        bot_id TEXT NOT NULL,
                        market TEXT NOT NULL,
                        buy_order_uuid TEXT NOT NULL,
                        sell_order_uuid TEXT,
                        buy_price REAL NOT NULL,
                        buy_volume TEXT NOT NULL,
                        buy_amount INTEGER NOT NULL,
                        buy_date TEXT NOT NULL,
                        sell_price REAL,
                        sell_volume TEXT,
                        sell_amount INTEGER,
                        sell_date TEXT,
                        profit_krw INTEGER,
                        profit_pct REAL,
                        status TEXT NOT NULL DEFAULT 'HOLDING',
                        FOREIGN KEY (bot_id) REFERENCES bots(bot_id)
                    )
                    """
                )

                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS bot_positions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        bot_id TEXT NOT NULL,
                        market TEXT NOT NULL,
                        order_uuid TEXT NOT NULL UNIQUE,
                        volume TEXT NOT NULL,
                        avg_buy_price REAL NOT NULL,
                        buy_amount INTEGER NOT NULL,
                        buy_fee REAL NOT NULL DEFAULT 0,
                        trade_id INTEGER NOT NULL,
                        status TEXT NOT NULL DEFAULT 'OPEN',
                        created_at TEXT NOT NULL,
                        closed_at TEXT,
                        FOREIGN KEY (bot_id) REFERENCES bots(bot_id),
                        FOREIGN KEY (trade_id) REFERENCES trades(id)
                    )
                    """
                )

                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise

        self._seed_defaults_if_empty()

    def _seed_defaults_if_empty(self) -> None:
        conn = self.get_connection()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        seed_check = conn.execute(
            "SELECT COUNT(*) AS cnt FROM trades WHERE buy_order_uuid LIKE 'seed-%'"
        ).fetchone()
        if seed_check and seed_check["cnt"] > 0:
            with self.transaction() as tx:
                tx.execute("DELETE FROM bot_positions WHERE order_uuid LIKE 'seed-%'")
                tx.execute("DELETE FROM trades WHERE buy_order_uuid LIKE 'seed-%'")
                tx.execute("DELETE FROM bots")
                tx.execute("DELETE FROM system_settings")

        default_bots = [
            {
                "bot_id": "bot_volatility",
                "name": "필터 결합형 변동성 돌파 봇",
                "nickname": "돌파봇-알파",
                "strategy_type": "VOLATILITY_BREAKOUT",
                "description": "장중 단타 / 1일 보유 | 변동성 돌파(K=0.4) + 20일 이평선 추세 필터 전략",
                "allocation_ratio": 40.0,
                "allocated_capital": 0,
                "virtual_krw": 0,
                "is_running": 0,
                "min_volume_krw": 10000000000,
                "stop_loss_pct": 2.5,
                "take_profit_pct": 4.5,
                "config_json": json.dumps(
                    {
                        "k_value": 0.4,
                        "ma_period": 20,
                        "volume_multiplier": 1.2,
                        "order_ratio": 0.3,
                    }
                ),
            },
            {
                "bot_id": "bot_dual_momentum",
                "name": "듀얼 모멘텀 스윙 봇",
                "nickname": "모멘텀봇-베타",
                "strategy_type": "DUAL_MOMENTUM",
                "description": "상대 모멘텀(상위 2종목) + 절대 모멘텀(+1.5% 이상) 스윙 전략",
                "allocation_ratio": 40.0,
                "allocated_capital": 0,
                "virtual_krw": 0,
                "is_running": 0,
                "min_volume_krw": 15000000000,
                "stop_loss_pct": 3.5,
                "take_profit_pct": 7.0,
                "config_json": json.dumps(
                    {
                        "lookback_days": 8,
                        "abs_momentum_threshold_pct": 1.5,
                        "top_n": 2,
                        "order_ratio": 0.35,
                    }
                ),
            },
            {
                "bot_id": "bot_bollinger_reversal",
                "name": "고변동성 볼린저 밴드 역추세 봇",
                "nickname": "볼린저봇-감마",
                "strategy_type": "BOLLINGER_REVERSAL",
                "description": "고변동성 코인 볼린저 밴드(20, 2.0σ) 15분봉 단기 반등 전략",
                "allocation_ratio": 20.0,
                "allocated_capital": 0,
                "virtual_krw": 0,
                "is_running": 0,
                "min_volume_krw": 8000000000,
                "stop_loss_pct": 2.0,
                "take_profit_pct": 3.5,
                "config_json": json.dumps(
                    {
                        "bb_period": 20,
                        "bb_std": 2.0,
                        "bb_stddev": 2.0,
                        "candle_unit": "minutes/15",
                        "order_krw": 15000,
                    }
                ),
            },
        ]

        row = conn.execute("SELECT COUNT(*) AS cnt FROM bots").fetchone()
        if row and row["cnt"] > 0:
            with self.transaction() as tx:
                for b in default_bots:
                    tx.execute(
                        """
                        UPDATE bots
                        SET nickname = CASE WHEN nickname = '' THEN ? ELSE nickname END,
                            description = ?,
                            allocation_ratio = CASE WHEN allocation_ratio = 0 THEN ? ELSE allocation_ratio END,
                            min_volume_krw = CASE WHEN min_volume_krw = 0 THEN ? ELSE min_volume_krw END,
                            stop_loss_pct = CASE WHEN stop_loss_pct = 0 THEN ? ELSE stop_loss_pct END,
                            take_profit_pct = CASE WHEN take_profit_pct = 0 THEN ? ELSE take_profit_pct END,
                            config_json = CASE WHEN config_json = '{}' OR config_json = '' THEN ? ELSE config_json END,
                            updated_at = ?
                        WHERE bot_id = ?
                        """,
                        (
                            b["nickname"],
                            b["description"],
                            b["allocation_ratio"],
                            b["min_volume_krw"],
                            b["stop_loss_pct"],
                            b["take_profit_pct"],
                            b["config_json"],
                            now_str,
                            b["bot_id"],
                        ),
                    )
            return

        default_settings = {
            "total_capital": "0",
            "capital_configured": "0",
            "zero_balance_halted": "0",
            "zero_balance_reason": "",
            "stats_start_date": "2026-10-01",
            "entry_code": "stock",
        }

        with self.transaction() as tx:
            for k, v in default_settings.items():
                tx.execute(
                    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
                    (k, v, now_str),
                )

            for b in default_bots:
                tx.execute(
                    """
                    INSERT INTO bots (
                        bot_id, name, nickname, strategy_type, description,
                        allocation_ratio, allocated_capital, virtual_krw, is_running,
                        min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
                        last_status_msg, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        b["bot_id"],
                        b["name"],
                        b["nickname"],
                        b["strategy_type"],
                        b["description"],
                        b["allocation_ratio"],
                        b["allocated_capital"],
                        b["virtual_krw"],
                        b["is_running"],
                        b["min_volume_krw"],
                        b["stop_loss_pct"],
                        b["take_profit_pct"],
                        b["config_json"],
                        "대기 중",
                        now_str,
                    ),
                )

    # ------------------------------------------------------------------
    # 시스템 설정 및 잔고 0 이하 전체 중지 로직 (요구사항 21, 22)
    # ------------------------------------------------------------------
    def get_setting(self, key: str, default: str = "") -> str:
        conn = self.get_connection()
        row = conn.execute("SELECT value FROM system_settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.transaction() as tx:
            tx.execute(
                "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
                (key, str(value), now_str),
            )

    def get_all_settings(self) -> Dict[str, str]:
        conn = self.get_connection()
        rows = conn.execute("SELECT key, value FROM system_settings").fetchall()
        return {r["key"]: r["value"] for r in rows}

    def check_and_halt_if_zero_balance(self) -> Dict[str, Any]:
        """
        설정된 총 잔고(total_capital) 또는 전체 가용 잔고 합계가 0 이하로 떨어진 경우
        모든 봇을 즉시 거래 중지(is_running = 0)시키고 알림 플래그를 활성화합니다.
        """
        conn = self.get_connection()
        if self.get_setting("capital_configured", "0") != "1":
            return {"halted": False, "reason": ""}

        total_capital = int(float(self.get_setting("total_capital", "0")))
        bots = self.get_bots()
        total_virtual_krw = sum(int(b["virtual_krw"]) for b in bots)
        open_positions = conn.execute(
            "SELECT COUNT(*) AS cnt FROM bot_positions WHERE status = 'OPEN'"
        ).fetchone()["cnt"]

        should_halt = False
        reason = ""
        if total_capital <= 0:
            should_halt = True
            reason = f"설정된 운용 원금({total_capital:,}원)이 0원 이하이므로 모든 봇이 자동 거래 중지되었습니다."
        elif total_virtual_krw <= 0 and open_positions == 0:
            should_halt = True
            reason = f"가용 가상 잔고({total_virtual_krw:,}원)가 0원 이하로 떨어져 모든 봇이 자동 거래 중지되었습니다."
        elif any(int(b["virtual_krw"]) < 0 for b in bots):
            should_halt = True
            reason = "특정 봇의 설정 잔고가 0원 이하로 하락하여 안전을 위해 모든 봇이 자동 거래 중지되었습니다."

        if should_halt:
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with self.transaction() as tx:
                tx.execute(
                    "UPDATE bots SET is_running = 0, last_status_msg = ?, updated_at = ?",
                    ("잔고 0 이하 도달로 긴급 자동 중지됨", now_str),
                )
                tx.execute(
                    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '1', ?)",
                    (now_str,),
                )
                tx.execute(
                    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', ?, ?)",
                    (reason, now_str),
                )
            return {"halted": True, "reason": reason}

        return {
            "halted": self.get_setting("zero_balance_halted", "0") == "1",
            "reason": self.get_setting("zero_balance_reason", ""),
        }

    def update_capital_allocations(
        self, total_capital: float, ratios: Dict[str, float]
    ) -> List[Dict[str, Any]]:
        """
        설정 화면에서 총 원금 및 봇별 자금 분배 비율(%)을 변경할 때 호출.
        소수점이 나오면 무조건 버림(math.floor)으로 설정 (요구사항 22).
        total_capital <= 0 인 경우 모든 봇 즉시 중지 (요구사항 21).
        """
        floored_total = math.floor(float(total_capital))
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        with self.transaction() as tx:
            tx.execute(
                "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)",
                (str(floored_total), now_str),
            )
            tx.execute(
                "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)",
                (now_str,),
            )

            for bot_id, ratio in ratios.items():
                ratio_val = float(ratio)
                # 소수점 버림(math.floor) 적용
                allocated = math.floor(floored_total * (ratio_val / 100.0))
                # 현재 해당 봇이 OPEN 포지션에 투입 중인 금액 계산
                pos_row = tx.execute(
                    "SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'",
                    (bot_id,),
                ).fetchone()
                invested = int(pos_row["invested"]) if pos_row else 0
                new_virtual_krw = max(0, allocated - invested) if floored_total > 0 else 0

                tx.execute(
                    """
                    UPDATE bots
                    SET allocation_ratio = ?,
                        allocated_capital = ?,
                        virtual_krw = ?,
                        updated_at = ?
                    WHERE bot_id = ?
                    """,
                    (ratio_val, allocated, new_virtual_krw, now_str, bot_id),
                )

            if floored_total > 0:
                tx.execute(
                    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '0', ?)",
                    (now_str,),
                )
                tx.execute(
                    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', '', ?)",
                    (now_str,),
                )

        self.check_and_halt_if_zero_balance()
        return self.get_bots()

    # ------------------------------------------------------------------
    # 봇 조회 및 수정 (요구사항 15, 20)
    # ------------------------------------------------------------------
    def get_bots(self) -> List[Dict[str, Any]]:
        conn = self.get_connection()
        rows = conn.execute("SELECT * FROM bots ORDER BY bot_id ASC").fetchall()
        result = []
        for r in rows:
            item = dict(r)
            try:
                item["config"] = json.loads(item.get("config_json") or "{}")
            except Exception:
                item["config"] = {}
            open_pos = conn.execute(
                "SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN' ORDER BY id DESC",
                (item["bot_id"],),
            ).fetchall()
            item["open_positions"] = [dict(p) for p in open_pos]
            result.append(item)
        return result

    def get_bot(self, bot_id: str) -> Optional[Dict[str, Any]]:
        for b in self.get_bots():
            if b["bot_id"] == bot_id:
                return b
        return None

    def update_bot_settings(
        self,
        bot_id: str,
        nickname: str,
        min_volume_krw: int,
        stop_loss_pct: float,
        take_profit_pct: float,
        config: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.transaction() as tx:
            tx.execute(
                """
                UPDATE bots
                SET nickname = ?,
                    min_volume_krw = ?,
                    stop_loss_pct = ?,
                    take_profit_pct = ?,
                    config_json = ?,
                    updated_at = ?
                WHERE bot_id = ?
                """,
                (
                    nickname.strip(),
                    math.floor(float(min_volume_krw)),
                    float(stop_loss_pct),
                    float(take_profit_pct),
                    json.dumps(config, ensure_ascii=False),
                    now_str,
                    bot_id,
                ),
            )
        return self.get_bot(bot_id)

    def set_bot_running(self, bot_id: str, is_running: bool, status_msg: str = "") -> Dict[str, Any]:
        if is_running:
            halt_check = self.check_and_halt_if_zero_balance()
            if halt_check["halted"]:
                return {
                    "success": False,
                    "bot": self.get_bot(bot_id),
                    "message": halt_check["reason"] or "설정된 잔고가 0원 이하이므로 거래를 시작할 수 없습니다.",
                }
            bot = self.get_bot(bot_id)
            if not bot:
                return {"success": False, "bot": None, "message": "존재하지 않는 봇입니다."}
            if int(bot.get("allocated_capital") or 0) <= 0:
                return {
                    "success": False,
                    "bot": bot,
                    "message": f"[{bot['nickname'] or bot['name']}] 할당 원금이 0원이므로 거래를 시작할 수 없습니다. 설정에서 원금 및 자금 분배 비율을 먼저 설정해주세요.",
                }
            if int(bot["virtual_krw"]) <= 0 and len(bot.get("open_positions", [])) == 0:
                return {
                    "success": False,
                    "bot": bot,
                    "message": f"[{bot['nickname']}] 할당된 가용 잔고(virtual_krw)가 0원 이하입니다. 설정에서 원금 및 분배 비율을 확인해주세요.",
                }

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        msg = status_msg or ("자동매매 실행 중" if is_running else "사용자에 의해 거래 중지됨")
        with self.transaction() as tx:
            tx.execute(
                "UPDATE bots SET is_running = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?",
                (1 if is_running else 0, msg, now_str, bot_id),
            )
        updated_bot = self.get_bot(bot_id)
        action_label = "거래 시작" if is_running else "거래 중지"
        return {
            "success": True,
            "bot": updated_bot,
            "message": f"[{updated_bot['nickname']}] {action_label} 명령이 정상적으로 처리되었습니다.",
        }

    def update_bot_status_message(self, bot_id: str, msg: str) -> None:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn = self.get_connection()
        conn.execute(
            "UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?",
            (msg, now_str, bot_id),
        )

    # ------------------------------------------------------------------
    # 주문 전 가상 잔고 트랜잭션 락 및 포지션/거래 기록 (요구사항 9, 23)
    # ------------------------------------------------------------------
    def execute_buy_with_virtual_lock(
        self,
        bot_id: str,
        market: str,
        requested_krw: int,
        order_callback,
    ) -> Dict[str, Any]:
        """
        주문 전 가상 잔고(virtual_krw) 트랜잭션 락(요구사항 23-3):
        - 실제 업비트 계좌 잔고와 무관하게 DB의 virtual_krw 값 이상으로 주문할 수 없도록 사전 예산 체크 및 락을 수행.
        - 소수점 버림(math.floor) 및 업비트 최소 주문 금액(5,000원), 매수 수수료(0.05%) 검증.
        - 동일 종목(예: KRW-BTC)에 다른 봇이 진입해 있더라도 order_uuid와 진입 수량을 bot_positions에 분리 기록(요구사항 23-2).
        """
        order_krw = math.floor(float(requested_krw))
        if order_krw < 5000:
            return {"success": False, "reason": f"최소 주문 금액(5,000원) 미만입니다: {order_krw:,}원"}

        fee_rate = Decimal("0.0005")
        total_required_krw = math.floor(float(Decimal(str(order_krw)) * (Decimal("1") + fee_rate)))

        with self.transaction() as tx:
            bot_row = tx.execute(
                "SELECT virtual_krw, nickname, is_running FROM bots WHERE bot_id = ?",
                (bot_id,),
            ).fetchone()
            if not bot_row:
                return {"success": False, "reason": f"봇({bot_id})을 찾을 수 없습니다."}
            if int(bot_row["virtual_krw"]) < total_required_krw:
                return {
                    "success": False,
                    "reason": (
                        f"[{bot_row['nickname']}] 가상 잔고(virtual_krw={int(bot_row['virtual_krw']):,}원) 초과 주문 차단 "
                        f"(요청 예산+수수료={total_required_krw:,}원)"
                    ),
                }

            # 공용 Open API 통신 모듈을 통해 매수 주문 실행
            order_res = order_callback(market=market, price_krw=order_krw)
            if not order_res.get("success"):
                return {"success": False, "reason": order_res.get("reason", "매수 주문 실패")}

            order_uuid = order_res["order_uuid"]
            executed_volume = (
                Decimal(str(order_res["executed_volume"]))
                .quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
            )
            avg_buy_price = float(order_res["avg_price"])
            actual_buy_amount = math.floor(float(order_res.get("executed_funds", order_krw)))
            paid_fee = float(order_res.get("paid_fee", round(actual_buy_amount * 0.0005, 2)))
            total_deducted = math.floor(actual_buy_amount + paid_fee)
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            # 1) 가상 잔고(virtual_krw) 차감
            new_virtual_krw = max(0, int(bot_row["virtual_krw"]) - total_deducted)
            tx.execute(
                "UPDATE bots SET virtual_krw = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?",
                (
                    new_virtual_krw,
                    f"{market} 매수 완료 ({actual_buy_amount:,}원)",
                    now_str,
                    bot_id,
                ),
            )

            # 2) trades 테이블에 매수 Row 생성 (매도/매도일/차익은 NULL -> 추후 매도 시 동일 Row 업데이트)
            cur = tx.execute(
                """
                INSERT INTO trades (
                    bot_id, market, buy_order_uuid, sell_order_uuid,
                    buy_price, buy_volume, buy_amount, buy_date,
                    sell_price, sell_volume, sell_amount, sell_date,
                    profit_krw, profit_pct, status
                ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'HOLDING')
                """,
                (
                    bot_id,
                    market,
                    order_uuid,
                    avg_buy_price,
                    f"{executed_volume:.8f}",
                    actual_buy_amount,
                    now_str,
                ),
            )
            trade_id = cur.lastrowid

            # 3) bot_positions 테이블에 본인 bot_id, order_uuid, volume 분리 기록 (요구사항 23-1, 23-2)
            tx.execute(
                """
                INSERT INTO bot_positions (
                    bot_id, market, order_uuid, volume,
                    avg_buy_price, buy_amount, buy_fee, trade_id,
                    status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
                """,
                (
                    bot_id,
                    market,
                    order_uuid,
                    f"{executed_volume:.8f}",
                    avg_buy_price,
                    actual_buy_amount,
                    paid_fee,
                    trade_id,
                    now_str,
                ),
            )

            return {
                "success": True,
                "trade_id": trade_id,
                "order_uuid": order_uuid,
                "market": market,
                "volume": f"{executed_volume:.8f}",
                "avg_buy_price": avg_buy_price,
                "buy_amount": actual_buy_amount,
                "virtual_krw": new_virtual_krw,
            }

    def execute_sell_by_bot_position(
        self,
        bot_id: str,
        position_id: int,
        sell_callback,
    ) -> Dict[str, Any]:
        """
        매도 시 전량 조회(get_balance) 직접 매도 절대 금지 (요구사항 23-1):
        반드시 로컬 DB의 bot_positions 테이블에서 본인 bot_id로 기록된 volume 수량만 조회하여 시장가 분할 매도하고,
        trades 테이블의 기존 매수 Row에 매도금액, 매도일, 차익을 업데이트합니다 (요구사항 9).
        """
        with self.transaction() as tx:
            pos_row = tx.execute(
                """
                SELECT * FROM bot_positions
                WHERE id = ? AND bot_id = ? AND status = 'OPEN'
                """,
                (position_id, bot_id),
            ).fetchone()

            if not pos_row:
                return {
                    "success": False,
                    "reason": f"bot_positions에서 해당 봇({bot_id})의 활성 포지션(id={position_id})을 찾을 수 없습니다.",
                }

            market = pos_row["market"]
            # 본인 bot_id로 기록된 정확한 volume 수량만 추출 (소수점 8자리 내림)
            position_volume = (
                Decimal(str(pos_row["volume"]))
                .quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
            )
            volume_str = f"{position_volume:.8f}"

            sell_res = sell_callback(
                bot_id=bot_id,
                market=market,
                volume=volume_str,
                buy_order_uuid=pos_row["order_uuid"],
            )
            if not sell_res.get("success"):
                return {"success": False, "reason": sell_res.get("reason", "매도 주문 실패")}

            sell_order_uuid = sell_res["order_uuid"]
            sell_price = float(sell_res["avg_price"])
            gross_sell_amount = math.floor(float(sell_res["executed_funds"]))
            sell_fee = float(sell_res.get("paid_fee", round(gross_sell_amount * 0.0005, 2)))
            net_sell_proceeds = math.floor(gross_sell_amount - sell_fee)

            buy_amount = int(pos_row["buy_amount"])
            buy_fee = float(pos_row["buy_fee"])
            profit_krw = math.floor(net_sell_proceeds - buy_amount - buy_fee)
            profit_pct = round((profit_krw / buy_amount) * 100.0, 2) if buy_amount > 0 else 0.0
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            # 1) bot_positions 상태 CLOSED 처리
            tx.execute(
                "UPDATE bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND bot_id = ?",
                (now_str, position_id, bot_id),
            )

            # 2) trades 테이블의 동일 Row 업데이트 (매도, 매도일, 차익 채움 - 요구사항 9)
            tx.execute(
                """
                UPDATE trades
                SET sell_order_uuid = ?,
                    sell_price = ?,
                    sell_volume = ?,
                    sell_amount = ?,
                    sell_date = ?,
                    profit_krw = ?,
                    profit_pct = ?,
                    status = 'COMPLETED'
                WHERE id = ? AND bot_id = ?
                """,
                (
                    sell_order_uuid,
                    sell_price,
                    volume_str,
                    gross_sell_amount,
                    now_str,
                    profit_krw,
                    profit_pct,
                    pos_row["trade_id"],
                    bot_id,
                ),
            )

            # 3) 봇의 virtual_krw 정산 반영
            bot_row = tx.execute(
                "SELECT virtual_krw FROM bots WHERE bot_id = ?", (bot_id,)
            ).fetchone()
            current_virtual = int(bot_row["virtual_krw"]) if bot_row else 0
            new_virtual = math.floor(current_virtual + net_sell_proceeds)
            tx.execute(
                "UPDATE bots SET virtual_krw = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?",
                (
                    new_virtual,
                    f"{market} 매도 완료 (차익 {profit_krw:+,}원)",
                    now_str,
                    bot_id,
                ),
            )

        self.check_and_halt_if_zero_balance()
        return {
            "success": True,
            "market": market,
            "volume": volume_str,
            "sell_price": sell_price,
            "sell_amount": gross_sell_amount,
            "profit_krw": profit_krw,
            "profit_pct": profit_pct,
        }

    # ------------------------------------------------------------------
    # 거래현황 및 통계 조회 (요구사항 9, 10, 11, 12)
    # ------------------------------------------------------------------
    def get_trades_by_bot(self, bot_id: Optional[str] = None) -> List[Dict[str, Any]]:
        conn = self.get_connection()
        if bot_id:
            rows = conn.execute(
                """
                SELECT t.*, b.nickname AS bot_nickname
                FROM trades t
                LEFT JOIN bots b ON t.bot_id = b.bot_id
                WHERE t.bot_id = ?
                ORDER BY t.buy_date DESC, t.id DESC
                """,
                (bot_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT t.*, b.nickname AS bot_nickname
                FROM trades t
                LEFT JOIN bots b ON t.bot_id = b.bot_id
                ORDER BY t.buy_date DESC, t.id DESC
                """
            ).fetchall()
        return [dict(r) for r in rows]

    def get_statistics(self, start_date: str = "2026-10-01") -> Dict[str, Any]:
        """
        통계 데이터 산출 (요구사항 10, 11, 12):
        - 시작 날짜: 2026.10.01 부터 집계
        - 일간 / 주간 / 월간 탭용 차익 선 그래프 데이터 제공
        - 하단 게시판: 가장 많이 거래된 코인 순으로 정렬 + 해당 코인의 주간, 월간, 연간 누적 손익 산출
        """
        conn = self.get_connection()
        rows = conn.execute(
            """
            SELECT * FROM trades
            WHERE substr(buy_date, 1, 10) >= ?
            ORDER BY COALESCE(sell_date, buy_date) ASC
            """,
            (start_date,),
        ).fetchall()
        trades = [dict(r) for r in rows]

        daily_map: Dict[str, int] = {}
        weekly_map: Dict[str, int] = {}
        monthly_map: Dict[str, int] = {}

        now_dt = datetime.now()
        current_iso_year, current_iso_week, _ = now_dt.isocalendar()
        current_month_prefix = now_dt.strftime("%Y-%m")
        current_year_prefix = now_dt.strftime("%Y")

        coin_stats: Dict[str, Dict[str, Any]] = {}

        for t in trades:
            market = t["market"]
            if market not in coin_stats:
                coin_stats[market] = {
                    "market": market,
                    "trade_count": 0,
                    "completed_count": 0,
                    "holding_count": 0,
                    "weekly_profit": 0,
                    "monthly_profit": 0,
                    "yearly_profit": 0,
                    "total_profit": 0,
                }

            coin_stats[market]["trade_count"] += 1

            if t["status"] == "COMPLETED" and t["profit_krw"] is not None:
                coin_stats[market]["completed_count"] += 1
                profit = int(t["profit_krw"])
                ref_date_str = (t.get("sell_date") or t.get("buy_date"))[:10]

                if ref_date_str < start_date:
                    continue

                # 1) 일간 집계
                daily_map[ref_date_str] = daily_map.get(ref_date_str, 0) + profit

                # 2) 주간 집계 (YYYY-Wnn)
                try:
                    dt_obj = datetime.strptime(ref_date_str, "%Y-%m-%d")
                    iso_y, iso_w, _ = dt_obj.isocalendar()
                    week_key = f"{iso_y}-W{iso_w:02d}"
                except Exception:
                    iso_y, iso_w = current_iso_year, current_iso_week
                    week_key = f"{current_iso_year}-W{current_iso_week:02d}"

                weekly_map[week_key] = weekly_map.get(week_key, 0) + profit

                # 3) 월간 집계 (YYYY-MM)
                month_key = ref_date_str[:7]
                monthly_map[month_key] = monthly_map.get(month_key, 0) + profit

                # 코인별 주간 / 월간 / 연간 누적 손익 집계
                coin_stats[market]["total_profit"] += profit
                if ref_date_str[:4] == current_year_prefix:
                    coin_stats[market]["yearly_profit"] += profit
                if ref_date_str[:7] == current_month_prefix:
                    coin_stats[market]["monthly_profit"] += profit
                if (iso_y, iso_w) == (current_iso_year, current_iso_week):
                    coin_stats[market]["weekly_profit"] += profit
            else:
                coin_stats[market]["holding_count"] += 1

        def _build_series(data_map: Dict[str, int]) -> List[Dict[str, Any]]:
            cumulative = 0
            series = []
            for label in sorted(data_map.keys()):
                period_profit = data_map[label]
                cumulative += period_profit
                series.append(
                    {
                        "label": label,
                        "profit": period_profit,
                        "cumulative_profit": cumulative,
                    }
                )
            return series

        # 시작일(2026.10.01) 기준점 보장
        if "2026-10-01" not in daily_map:
            daily_map["2026-10-01"] = 0
        if "2026-10" not in monthly_map:
            monthly_map["2026-10"] = 0

        # 가장 많이 거래된 코인 순으로 정렬 (요구사항 12)
        coin_ranking = sorted(
            coin_stats.values(),
            key=lambda x: (x["trade_count"], x["yearly_profit"]),
            reverse=True,
        )

        return {
            "start_date": "2026.10.01",
            "daily": _build_series(daily_map),
            "weekly": _build_series(weekly_map),
            "monthly": _build_series(monthly_map),
            "coin_ranking": coin_ranking,
        }

    # ------------------------------------------------------------------
    # 데이터 마이그레이션(JSON 내보내기) 및 복원(JSON 가져오기) (요구사항 13)
    # ------------------------------------------------------------------
    def export_all_to_dict(self) -> Dict[str, Any]:
        conn = self.get_connection()
        settings = [dict(r) for r in conn.execute("SELECT * FROM system_settings").fetchall()]
        bots = [dict(r) for r in conn.execute("SELECT * FROM bots").fetchall()]
        trades = [dict(r) for r in conn.execute("SELECT * FROM trades").fetchall()]
        positions = [dict(r) for r in conn.execute("SELECT * FROM bot_positions").fetchall()]

        return {
            "schema_version": "1.0",
            "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "system_settings": settings,
            "bots": bots,
            "trades": trades,
            "bot_positions": positions,
        }

    def import_all_from_dict(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(payload, dict) or "bots" not in payload or "trades" not in payload:
            raise ValueError("유효하지 않은 마이그레이션 JSON 파일 형식입니다.")

        with self.transaction() as tx:
            tx.execute("DELETE FROM bot_positions")
            tx.execute("DELETE FROM trades")
            tx.execute("DELETE FROM bots")
            tx.execute("DELETE FROM system_settings")

            for s in payload.get("system_settings", []):
                tx.execute(
                    "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
                    (s["key"], str(s["value"]), s.get("updated_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                )

            for b in payload.get("bots", []):
                tx.execute(
                    """
                    INSERT INTO bots (
                        bot_id, name, nickname, strategy_type, description,
                        allocation_ratio, allocated_capital, virtual_krw, is_running,
                        min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
                        last_status_msg, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        b["bot_id"],
                        b["name"],
                        b["nickname"],
                        b["strategy_type"],
                        b.get("description", ""),
                        float(b.get("allocation_ratio", 33.33)),
                        math.floor(float(b.get("allocated_capital", 0))),
                        math.floor(float(b.get("virtual_krw", 0))),
                        int(b.get("is_running", 0)),
                        math.floor(float(b.get("min_volume_krw", 5000000000))),
                        float(b.get("stop_loss_pct", 3.0)),
                        float(b.get("take_profit_pct", 5.0)),
                        b.get("config_json", "{}"),
                        b.get("last_status_msg", "복원 완료"),
                        b.get("updated_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    ),
                )

            for t in payload.get("trades", []):
                tx.execute(
                    """
                    INSERT INTO trades (
                        id, bot_id, market, buy_order_uuid, sell_order_uuid,
                        buy_price, buy_volume, buy_amount, buy_date,
                        sell_price, sell_volume, sell_amount, sell_date,
                        profit_krw, profit_pct, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        t.get("id"),
                        t["bot_id"],
                        t["market"],
                        t["buy_order_uuid"],
                        t.get("sell_order_uuid"),
                        float(t["buy_price"]),
                        str(t["buy_volume"]),
                        math.floor(float(t["buy_amount"])),
                        t["buy_date"],
                        float(t["sell_price"]) if t.get("sell_price") is not None else None,
                        str(t["sell_volume"]) if t.get("sell_volume") is not None else None,
                        math.floor(float(t["sell_amount"])) if t.get("sell_amount") is not None else None,
                        t.get("sell_date"),
                        math.floor(float(t["profit_krw"])) if t.get("profit_krw") is not None else None,
                        float(t["profit_pct"]) if t.get("profit_pct") is not None else None,
                        t.get("status", "HOLDING"),
                    ),
                )

            seen_pos_uuids = set()
            for idx, p in enumerate(payload.get("bot_positions", [])):
                raw_uuid = str(p.get("order_uuid") or "").strip()
                if not raw_uuid:
                    raw_uuid = f"restored-pos-{p.get('id') or (idx + 1)}-{int(datetime.now().timestamp())}"
                if raw_uuid in seen_pos_uuids:
                    raw_uuid = f"{raw_uuid}-dup-{p.get('id') or (idx + 1)}"
                seen_pos_uuids.add(raw_uuid)

                pos_id = p.get("id")
                if pos_id is not None:
                    tx.execute(
                        """
                        INSERT OR REPLACE INTO bot_positions (
                            id, bot_id, market, order_uuid, volume,
                            avg_buy_price, buy_amount, buy_fee, trade_id,
                            status, created_at, closed_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            pos_id,
                            p["bot_id"],
                            p["market"],
                            raw_uuid,
                            str(p["volume"]),
                            float(p["avg_buy_price"]),
                            math.floor(float(p["buy_amount"])),
                            float(p.get("buy_fee", 0.0)),
                            int(p["trade_id"]),
                            p.get("status", "OPEN"),
                            p.get("created_at") or now_str,
                            p.get("closed_at"),
                        ),
                    )
                else:
                    tx.execute(
                        """
                        INSERT INTO bot_positions (
                            bot_id, market, order_uuid, volume,
                            avg_buy_price, buy_amount, buy_fee, trade_id,
                            status, created_at, closed_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            p["bot_id"],
                            p["market"],
                            raw_uuid,
                            str(p["volume"]),
                            float(p["avg_buy_price"]),
                            math.floor(float(p["buy_amount"])),
                            float(p.get("buy_fee", 0.0)),
                            int(p["trade_id"]),
                            p.get("status", "OPEN"),
                            p.get("created_at") or now_str,
                            p.get("closed_at"),
                        ),
                    )

        self.check_and_halt_if_zero_balance()
        return {
            "restored_bots": len(payload.get("bots", [])),
            "restored_trades": len(payload.get("trades", [])),
            "restored_positions": len(payload.get("bot_positions", [])),
        }


db_manager = DatabaseManager()

