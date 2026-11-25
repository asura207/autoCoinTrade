# [Antigravity-Doc] ============================================================
# [Antigravity-Doc] 파일 역할: agentBot 패키지 진입점(__init__.py) 및 공개 심볼 재수출(Re-export) 모듈
# [Antigravity-Doc] 아키텍처 위치: 10대 알고리즘 트레이딩 봇 중 독립 모듈화된 전략(bot_10 잭 켈로그)을 외부(bots.py, 테스트 등)에 일관된 네임스페이스로 노출
# [Antigravity-Doc] 주요 의존성: agentBot.bot_10_jack_kellogg (VWAP/LRC 지표 계산, 전략 평가, 독립 워커 프로세스)
# [Antigravity-Doc] 수정 시 주의사항: 신규 봇 모듈을 패키지에 추가할 때는 아래 import와 __all__ 리스트를 함께 갱신해야 와일드카드 임포트 및 정적 분석 정합성이 유지됨
# [Antigravity-Doc] ============================================================
"""
agentBot - 10대 알고리즘 트레이딩 봇 패키지
"""
# [Antigravity-Doc] bot_10(잭 켈로그 프라이스 액션 전략)의 핵심 지표 계산·시그널 평가·워커 실행 함수를 패키지 루트로 재수출
from .bot_10_jack_kellogg import (
    calculate_kellogg_indicators,
    compute_linear_regression_channel,
    compute_vwap,
    evaluate_jack_kellogg_strategy,
    run_bot_jack_kellogg,
)

# [Antigravity-Doc] 패키지 외부 공개 API 목록(__all__): bots.py 및 단위 테스트에서 참조하는 공식 심볼 정의
__all__ = [
    "compute_linear_regression_channel",
    "compute_vwap",
    "calculate_kellogg_indicators",
    "evaluate_jack_kellogg_strategy",
    "run_bot_jack_kellogg",
]
