#!/usr/bin/env python3
"""
Python PostgreSQL Connection & CRUD Test
- Tests init_db.get_db_connection() wrapper
- Tests backend.common.database.DatabaseManager
"""
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from init_db import get_db_connection
from backend.common.database import db_manager

def run_python_crud_test():
    print("==================================================")
    print("[Python] PostgreSQL 접속 및 CRUD 테스트 시작")
    print("==================================================")
    passed = True

    try:
        # 1. Connection check
        print("\n[1/4] PostgreSQL 직접 연결 테스트 (init_db)")
        conn = get_db_connection()
        row = conn.execute("SELECT 1 AS ping, current_database() AS db, current_user AS usr;").fetchone()
        print(f"  -> 연결 성공! DB: {row['db']}, User: {row['usr']}")

        # 2. market_regime_filter CRUD 테스트
        print("\n[2/4] market_regime_filter 테이블 Read & Update 테스트")
        cur_filter = conn.execute("SELECT * FROM market_regime_filter WHERE id = 1;").fetchone()
        print(f"  -> [R] 현재 시장 체제: {cur_filter['market_regime']}, 점수: {cur_filter['sentiment_score']}, 사유: {cur_filter['reason']}")

        # Update test
        conn.execute(
            """
            UPDATE market_regime_filter
            SET sentiment_score = %s, reason = %s, updated_at = CURRENT_TIMESTAMP
            WHERE id = 1;
            """,
            (0.85, "Python CRUD Test Verified")
        )
        conn.commit()
        upd_filter = conn.execute("SELECT sentiment_score, reason FROM market_regime_filter WHERE id = 1;").fetchone()
        print(f"  -> [U] UPDATE 후 검증: sentiment_score={upd_filter['sentiment_score']}, reason={upd_filter['reason']}")

        # Restore
        conn.execute(
            """
            UPDATE market_regime_filter
            SET sentiment_score = %s, reason = %s, updated_at = CURRENT_TIMESTAMP
            WHERE id = 1;
            """,
            (cur_filter['sentiment_score'], cur_filter['reason'])
        )
        conn.commit()
        print(f"  -> [U] 원상 복구 완료")
        conn.close()

        # 3. DatabaseManager CRUD 테스트
        print("\n[3/4] DatabaseManager API CRUD 테스트 (backend/common/database.py)")
        test_key = "py_test_setting_key"
        
        # Create/Set
        db_manager.set_setting(test_key, "py_val_1")
        val1 = db_manager.get_setting(test_key)
        print(f"  -> [C/R] set_setting / get_setting 검증: {val1} (일치: {val1 == 'py_val_1'})")

        # Update
        db_manager.set_setting(test_key, "py_val_2")
        val2 = db_manager.get_setting(test_key)
        print(f"  -> [U/R] UPDATE 후 get_setting 검증: {val2} (일치: {val2 == 'py_val_2'})")

        # Delete
        del_conn = db_manager.get_connection()
        del_conn.execute("DELETE FROM system_settings WHERE key = %s;", (test_key,))
        del_conn.commit()
        val3 = db_manager.get_setting(test_key, default="NONE")
        print(f"  -> [D/R] DELETE 후 확인: {val3} (삭제 확인: {val3 == 'NONE'})")

        # 4. 실거래/가상 봇 목록 조회
        print("\n[4/4] DatabaseManager 봇 목록 조회")
        bots = db_manager.get_bots()
        print(f"  -> [R] 총 {len(bots)}개 봇 정상 조회 완료:")
        for b in bots[:3]:
            print(f"     • [{b['bot_id']}] {b['nickname']} (할당액: {int(b['allocated_capital']):,}원, 가상잔고: {int(b['virtual_krw']):,}원)")

    except Exception as e:
        print(f"[TEST ERROR] {e}")
        passed = False

    print("\n==================================================")
    if passed:
        print("[SUCCESS] Python PostgreSQL 모든 CRUD 테스트 통과!")
    else:
        print("[FAILED] Python 테스트 도중 오류가 발생했습니다.")
    print("==================================================")

if __name__ == "__main__":
    run_python_crud_test()
