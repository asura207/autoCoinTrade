"""
tests/qa_python_verification.py

autoCoinTrade Python 워커·DB·전략 전수 QA 자동화 유닛 테스트 (격리 임시 DB · 실거래 API 0회 호출)
- 운영 DB(data/auto_coin_trade.db) 및 실계좌 API를 절대 건드리지 않습니다.
- TemporaryDirectory 컨텍스트 종료 시 임시 DB 파일이 자동 삭제됩니다.
"""

import datetime
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT_DIR = Path(__file__).resolve().parent.parent
VENV_DIR = (ROOT_DIR / ".venv").resolve()
VENV_PYTHON = VENV_DIR / "bin" / "python"
if VENV_PYTHON.exists() and Path(sys.prefix).resolve() != VENV_DIR:
    os.execv(str(VENV_PYTHON), [str(VENV_PYTHON), __file__, *sys.argv[1:]])

import numpy as np
import pandas as pd

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import init_db
import bots
import llm_filter_worker
from agentBot import bot_10_jack_kellogg


class TestPythonQaVerification(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="autocoin-py-qa-")
        self.db_path = os.path.join(self._tmp.name, "qa_py_test.db")
        self._orig_env = {
            "DB_MODE": os.environ.get("DB_MODE"),
            "PG_SYNC_ENABLED": os.environ.get("PG_SYNC_ENABLED"),
            "AUTOCOIN_DB_PATH": os.environ.get("AUTOCOIN_DB_PATH"),
            "DRY_RUN": os.environ.get("DRY_RUN"),
            "LOCAL_PG_HOST": os.environ.get("LOCAL_PG_HOST"),
            "LIVE_EXECUTOR_OWNER": os.environ.get("LIVE_EXECUTOR_OWNER"),
        }
        os.environ["DB_MODE"] = "sqlite"
        os.environ["PG_SYNC_ENABLED"] = "false"
        os.environ["AUTOCOIN_DB_PATH"] = self.db_path
        os.environ["DRY_RUN"] = "True"
        init_db.init_database(self.db_path)

    def tearDown(self):
        for k, v in self._orig_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def test_01_init_db_sqlite_default_and_pg_sql_conversion(self):
        # Unset DB_MODE must default to SQLite even if LOCAL_PG_HOST is set
        os.environ["DB_MODE"] = ""
        os.environ["PG_SYNC_ENABLED"] = ""
        os.environ["LOCAL_PG_HOST"] = "127.0.0.1"
        self.assertTrue(init_db.is_sqlite_mode())

        # PgConnectionWrapper must strip trailing ';' before appending ON CONFLICT
        wrapper = init_db.PgConnectionWrapper(None)
        converted = wrapper._convert_sql(
            "INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?);"
        )
        self.assertNotIn("); ON CONFLICT", converted)
        self.assertTrue(converted.endswith("ON CONFLICT (key) DO NOTHING;"))

        converted_rep = wrapper._convert_sql(
            "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?);"
        )
        self.assertNotIn("); ON CONFLICT", converted_rep)
        self.assertIn("ON CONFLICT (key) DO UPDATE", converted_rep)

        # Verify buy_reason column exists on bot_positions & paper_bot_positions + news index + accurate bot names
        conn = init_db.get_db_connection(self.db_path)
        try:
            pos_cols = {dict(r)["name"] for r in conn.execute("PRAGMA table_info(bot_positions);").fetchall()}
            paper_pos_cols = {dict(r)["name"] for r in conn.execute("PRAGMA table_info(paper_bot_positions);").fetchall()}
            self.assertIn("buy_reason", pos_cols)
            self.assertIn("buy_reason", paper_pos_cols)

            idx_rows = [dict(r)["name"] for r in conn.execute("PRAGMA index_list(crypto_news);").fetchall()]
            self.assertIn("idx_crypto_news_pubdate", idx_rows)

            bot4 = dict(conn.execute("SELECT name FROM bot_accounts WHERE bot_id = 'bot_04';").fetchone())
            self.assertEqual(bot4["name"], "볼린저 스퀴즈 돌파봇")
        finally:
            conn.close()

    def test_02_decimal_precision_and_no_scientific_notation(self):
        self.assertEqual(bots.round_down_volume_8("0.29"), 0.29)
        self.assertEqual(bots.round_down_volume_8("0.123456789"), 0.12345678)
        self.assertEqual(bots.format_volume_8(0.00005), "0.00005000")
        self.assertNotIn("e", bots.format_volume_8(0.00000001).lower())
        self.assertEqual(bots.round_down_volume_8(float("nan")), 0.0)
        self.assertEqual(bots.round_down_volume_8(-1.5), 0.0)

    def test_03_smart_exit_kst_timestop_and_setup_b_exemption(self):
        # Fresh KST position must NOT trigger Time-Stop on UTC host!
        now_kst = bots._now_kst_str()
        fresh_pos = {
            "avg_buy_price": 100000.0,
            "highest_price": 100000.0,
            "created_at": now_kst,
            "buy_reason": "VB_BREAKOUT",
        }
        res_fresh = bots.evaluate_smart_exit("bot_01", fresh_pos, 100000.0, atr=0.0, rvol=0.2, is_live=False)
        self.assertIsNone(res_fresh)

        # Position opened 3 hours ago in KST box with low RVOL -> triggers Time-Stop in paper mode (2h)
        old_kst = (datetime.datetime.now(bots.KST_TZ) - datetime.timedelta(hours=3)).strftime("%Y-%m-%d %H:%M:%S")
        old_pos = {
            "avg_buy_price": 100000.0,
            "highest_price": 100000.0,
            "created_at": old_kst,
            "buy_reason": "VB_BREAKOUT",
        }
        res_old = bots.evaluate_smart_exit("bot_01", old_pos, 100200.0, atr=0.0, rvol=0.5, is_live=False)
        self.assertIsNotNone(res_old)
        self.assertIn("TIME_STOP", res_old["reason"])

        # bot_10 Setup B must be exempt from ATR_HARD_STOP
        setup_b_pos = {
            "avg_buy_price": 100000.0,
            "highest_price": 100000.0,
            "created_at": now_kst,
            "buy_reason": "[Setup B 반등 1차] LRC 하단 터치",
        }
        res_b = bots.evaluate_smart_exit("bot_10", setup_b_pos, 98000.0, atr=500.0, rvol=0.5, is_live=True)
        self.assertIsNone(res_b)

        # ATR trailing stop must require peak >= +1.0% and stop > avg_buy
        small_peak_pos = {
            "avg_buy_price": 100000.0,
            "highest_price": 100300.0,
            "created_at": now_kst,
            "buy_reason": "VB_BREAKOUT",
        }
        res_small_peak = bots.evaluate_smart_exit("bot_01", small_peak_pos, 99800.0, atr=1000.0, rvol=1.5, is_live=True)
        self.assertIsNone(res_small_peak)

    def test_04_buy_sell_graceful_drain_zerosum_and_handoff_log(self):
        # Seed active & draining bots
        conn = init_db.get_db_connection(self.db_path)
        now_kst = bots._now_kst_str()
        conn.execute(
            """
            INSERT OR IGNORE INTO bots (bot_id, name, nickname, strategy_type, allocation_ratio, allocated_capital, virtual_krw, is_running, is_selected_for_live, updated_at)
            VALUES
              ('bot_01', '변동성 돌파봇', '알파', 'VOLATILITY_BREAKOUT', 0, 100000, 100000, 0, 0, ?),
              ('bot_03', '듀얼 모멘텀봇', '베타', 'DUAL_MOMENTUM', 60, 0, 0, 1, 1, ?),
              ('bot_05', '볼린저 반등봇', '감마', 'BOLLINGER_REVERSAL', 40, 0, 0, 1, 1, ?);
            """,
            (now_kst, now_kst, now_kst),
        )
        conn.execute("UPDATE bot_accounts SET is_selected_for_live = 0, allocation_ratio = 0, allocated_capital = 100000, virtual_krw = 100000 WHERE bot_id = 'bot_01';")
        conn.execute("UPDATE bot_accounts SET is_selected_for_live = 1, allocation_ratio = 60, allocated_capital = 0, virtual_krw = 0 WHERE bot_id = 'bot_03';")
        conn.execute("UPDATE bot_accounts SET is_selected_for_live = 1, allocation_ratio = 40, allocated_capital = 0, virtual_krw = 0 WHERE bot_id = 'bot_05';")
        conn.commit()
        conn.close()

        with patch.object(bots, "is_backend_running", return_value=False), patch.object(
            bots, "get_safe_current_price", return_value=100000.0
        ):
            buy_res = bots.execute_buy_order(
                "bot_01", "KRW-BTC", 50000.0, step_level=1, db_path=self.db_path, buy_reason="[Setup B 반등 1차]"
            )
            self.assertIsNotNone(buy_res)
            self.assertGreater(buy_res["trade_id"], 0)

        conn = init_db.get_db_connection(self.db_path)
        pos_row = dict(conn.execute("SELECT * FROM bot_positions WHERE bot_id = 'bot_01' AND status = 'OPEN';").fetchone())
        self.assertEqual(pos_row["buy_reason"], "[Setup B 반등 1차]")
        conn.close()

        # Sell at +10% (110,000) -> Draining bot_01 hands off remaining cash (50,000) + net proceeds to bot_03(60%) & bot_05(40%) with Zero-Sum!
        with patch.object(bots, "is_backend_running", return_value=False), patch.object(
            bots, "get_safe_current_price", return_value=110000.0
        ):
            sell_res = bots.execute_sell_order(pos_row["id"], reason="QA_DRAIN_EXIT", db_path=self.db_path)
            self.assertIsNotNone(sell_res)

        conn = init_db.get_db_connection(self.db_path)
        try:
            b1 = dict(conn.execute("SELECT virtual_krw, allocated_capital FROM bots WHERE bot_id = 'bot_01';").fetchone())
            b3 = dict(conn.execute("SELECT virtual_krw, allocated_capital FROM bots WHERE bot_id = 'bot_03';").fetchone())
            b5 = dict(conn.execute("SELECT virtual_krw, allocated_capital FROM bots WHERE bot_id = 'bot_05';").fetchone())
            self.assertEqual(b1["virtual_krw"], 0)
            self.assertEqual(b1["allocated_capital"], 0)
            handoff_rows = conn.execute("SELECT * FROM drain_handoff_logs WHERE from_bot_id = 'bot_01';").fetchall()
            self.assertEqual(len(handoff_rows), 1, "drain_handoff_logs must record handoff without pos_dict NameError!")
            expected_total = int(dict(handoff_rows[0])["net_proceeds_krw"])
            self.assertEqual(b3["virtual_krw"] + b5["virtual_krw"], expected_total, "Zero-Sum invariant must hold to 1 KRW!")
        finally:
            conn.close()

    def test_05_zero_active_bots_preserves_cash_and_market_sell_none_price(self):
        # All bots unselected -> draining sell must NOT evaporate cash to 0!
        conn = init_db.get_db_connection(self.db_path)
        now_kst = bots._now_kst_str()
        conn.execute(
            "INSERT OR REPLACE INTO bots (bot_id, name, nickname, strategy_type, allocation_ratio, allocated_capital, virtual_krw, is_running, is_selected_for_live, updated_at) VALUES ('bot_02', '슈퍼트렌드', '슈퍼', 'SUPERTREND_ATR', 0, 50000, 0, 0, 0, ?);",
            (now_kst,),
        )
        conn.execute("UPDATE bot_accounts SET is_selected_for_live = 0, allocation_ratio = 0, allocated_capital = 0, virtual_krw = 0;")
        conn.execute("UPDATE bot_accounts SET allocated_capital = 50000 WHERE bot_id = 'bot_02';")
        conn.execute(
            """
            INSERT INTO bot_positions (bot_id, market, ticker, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, highest_price, step_level, status, created_at)
            VALUES ('bot_02', 'KRW-ETH', 'KRW-ETH', 'qa-py-zero-active', '0.01000000', 5000000, 50000, 25, 0, 5000000, 1, 'OPEN', ?);
            """,
            (now_kst,),
        )
        conn.commit()
        pos_id = dict(conn.execute("SELECT id FROM bot_positions WHERE order_uuid = 'qa-py-zero-active';").fetchone())["id"]
        conn.close()

        # Simulate LIVE market sell where Upbit returns {"price": None, "trades": []}
        class DummyUpbit:
            def sell_limit_order(self, *args, **kwargs):
                return None

            def sell_market_order(self, ticker, vol):
                return {"uuid": "live-mkt-sell-uuid"}

            def get_order(self, uid):
                return {
                    "uuid": uid,
                    "state": "done",
                    "price": None,
                    "executed_volume": "0.01000000",
                    "paid_fee": "26.0",
                    "trades": [],
                }

        os.environ["DRY_RUN"] = "False"
        # Layer 1 Guardrail 검증: 기본 LIVE_EXECUTOR_OWNER='node' 상태에서는 Python 실전 매도 원천 차단
        os.environ["LIVE_EXECUTOR_OWNER"] = "node"
        with patch.object(bots, "is_backend_running", return_value=False), patch.object(
            bots, "get_upbit_client", return_value=DummyUpbit()
        ), patch.object(bots, "get_safe_current_price", return_value=5200000.0):
            blocked_res = bots.execute_sell_order(pos_id, reason="QA_OWNER_BLOCK", db_path=self.db_path)
            self.assertIsNone(blocked_res, "Python live sell must be hard-blocked when LIVE_EXECUTOR_OWNER=node")

        # 명시적으로 LIVE_EXECUTOR_OWNER='python' 인 경우에만 Python 실전 매도 허용
        os.environ["LIVE_EXECUTOR_OWNER"] = "python"
        with patch.object(bots, "is_backend_running", return_value=False), patch.object(
            bots, "get_upbit_client", return_value=DummyUpbit()
        ), patch.object(bots, "get_safe_current_price", return_value=5200000.0), patch.object(
            bots, "execute_limit_order_with_polling", return_value=None
        ):
            res = bots.execute_sell_order(pos_id, reason="QA_NONE_PRICE", db_path=self.db_path)
            self.assertIsNotNone(res)
            self.assertGreater(res["net_sell_amount"], 50000.0)

        conn = init_db.get_db_connection(self.db_path)
        try:
            b2 = dict(conn.execute("SELECT virtual_krw, allocated_capital FROM bots WHERE bot_id = 'bot_02';").fetchone())
            self.assertGreater(b2["virtual_krw"], 50000, "Cash must be retained when 0 active bots exist (Zero-Sum)")
            self.assertEqual(b2["virtual_krw"], b2["allocated_capital"])
        finally:
            conn.close()

    def test_06_bot_10_tz_aware_vwap_rvol_and_zero_div_guard(self):
        idx = pd.date_range("2026-11-19 00:00:00", periods=30, freq="15min", tz="UTC")
        df_15m = pd.DataFrame(
            {
                "open": np.linspace(1000, 1030, 30),
                "high": np.linspace(1005, 1035, 30),
                "low": np.linspace(995, 1025, 30),
                "close": np.linspace(1002, 1032, 30),
                "volume": np.zeros(30),
            },
            index=idx,
        )
        k = bot_10_jack_kellogg.calculate_kellogg_indicators(df_15m, df_day=None, current_price=1032.0)
        self.assertIsNotNone(k)
        self.assertEqual(k["today_open"], 0.0)
        self.assertEqual(k["prev_low"], 0.0)
        self.assertEqual(k["rvol"], 0.0)

        # Guard avg_buy_price = 0 on Setup B 2nd split check (must not raise ZeroDivisionError)
        eval_res = bot_10_jack_kellogg.evaluate_jack_kellogg_strategy(
            k,
            1000.0,
            open_positions=[{"avg_buy_price": 0, "volume": 1.0, "buy_amount": 0, "buy_reason": "[Setup B 반등 1차]"}],
            is_live=True,
        )
        self.assertIn(eval_res["signal"], ("HOLD", "SELL", "BUY"))

    def test_07_llm_filter_worker_bool_parsing_and_btc_failsafe(self):
        raw_json = json.dumps(
            {
                "sentiment_score": 0.25,
                "market_regime": "BULL",
                "risk_alert": "false",
                "recommended_action": "NORMAL",
                "position_size_multiplier": 1.0,
                "bot_overrides": {"bot_01": "ALLOW"},
                "blacklist_tickers": [],
                "reason": "String false test",
            }
        )
        parsed = llm_filter_worker.parse_and_validate_llm_json(raw_json)
        self.assertIsNotNone(parsed)
        self.assertFalse(parsed["risk_alert"], 'String "false" must parse as False, not bool("false")==True')
        self.assertEqual(parsed["position_size_multiplier"], 1.0)

        # BTC price=0 outage must Fail-Safe to SIDEWAYS / REDUCE_SIZE / 0.5x with trend bots BLOCKED
        fb = llm_filter_worker.make_fallback_regime(
            {"current_price": 0.0, "ma20": 0.0, "is_above_ma20": False, "is_above_ma60_4h": False},
            "OutageTest",
        )
        self.assertEqual(fb["market_regime"], "SIDEWAYS")
        self.assertEqual(fb["recommended_action"], "REDUCE_SIZE")
        self.assertEqual(fb["position_size_multiplier"], 0.5)
        self.assertEqual(fb["bot_overrides"]["bot_01"], "BLOCK")
        self.assertEqual(fb["bot_overrides"]["bot_05"], "ALLOW")

        # Cached fallback must NOT insert duplicate briefing rows
        llm_filter_worker.save_ai_briefings_to_db(
            {"provider": "ollama", "model": "qwen3-news", "is_cached_fallback": True},
            {"provider": "fallback", "model": "mechanical-btc-20ma", "is_cached_fallback": True},
            {"market_regime": "SIDEWAYS", "recommended_action": "NORMAL", "final_position_multiplier": 1.0, "final_bot_overrides": {}, "reason": "cached"},
            {"current_price": 100.0, "ma20": 95.0, "ma60_4h": 95.0},
            [],
            db_path=self.db_path,
            flash_ran=True,
            pro_ran=False,
        )
        conn = init_db.get_db_connection(self.db_path)
        try:
            cnt = dict(conn.execute("SELECT COUNT(*) AS c FROM ai_market_briefings;").fetchone())["c"]
            self.assertEqual(cnt, 0, "Cached fallback must not insert duplicate briefings")
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
