"""
agentBot 패키지 (요구사항 4, 16, 17, 23, 24)
각 봇의 매매기법을 언제든지 독립적으로 수정할 수 있도록 봇별로 소스를 분리한 패키지입니다.
- volatility_breakout_bot.py : 필터 결합형 변동성 돌파 (장중 단타 / 1일 보유)
- dual_momentum_bot.py       : 상대 모멘텀 + 절대 모멘텀 (듀얼 모멘텀 스윙)
- bollinger_reversal_bot.py  : 고변동성 코인 볼린저 밴드 역추세 (분봉 단기 반등 매매)
"""

from agentBot.base_bot import BaseTradingBot
from agentBot.volatility_breakout_bot import VolatilityBreakoutBot
from agentBot.dual_momentum_bot import DualMomentumBot
from agentBot.bollinger_reversal_bot import BollingerReversalBot

__all__ = [
    "BaseTradingBot",
    "VolatilityBreakoutBot",
    "DualMomentumBot",
    "BollingerReversalBot",
]
