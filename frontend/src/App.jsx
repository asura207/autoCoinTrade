import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";

const API_BASE = "";

function formatKRW(val) {
  if (val === null || val === undefined || val === "") return "";
  const cleaned = String(val).replace(/,/g, "");
  const num = Number(cleaned);
  if (Number.isNaN(num)) return "";
  return `${Math.floor(num).toLocaleString("ko-KR")}원`;
}

function formatWithCommas(val) {
  if (val === null || val === undefined || val === "") return "";
  const str = String(val).replace(/,/g, "").trim();
  if (str === "" || str === "-") return str;
  const num = Number(str);
  if (Number.isNaN(num)) return "";
  return Math.floor(num).toLocaleString("ko-KR");
}

function parseNumericInput(val) {
  if (val === null || val === undefined) return "";
  const cleaned = String(val).replace(/[^0-9-]/g, "");
  if (cleaned === "" || cleaned === "-") return "";
  const num = Number(cleaned);
  return Number.isNaN(num) ? "" : Math.floor(num);
}

function formatDateTimeKST(val) {
  if (!val) return "-";
  try {
    const raw = String(val).trim();
    if (!raw.includes("Z") && !raw.includes("+") && raw.includes(" ") && raw.length >= 19) {
      return raw.slice(0, 19);
    }
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      const formatter = new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const parts = formatter.formatToParts(d);
      const map = {};
      for (const p of parts) map[p.type] = p.value;
      return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
    }
  } catch {}
  return String(val).replace("T", " ").slice(0, 19);
}

function computeAllocationPreview(rawTotalCapital, botsList, ratiosMap) {
  const flooredTotal = Math.max(0, Math.floor(Number(rawTotalCapital || 0)));
  const items = (botsList || []).map((b) => {
    const used = Math.floor(
      Number(
        b.used_capital !== undefined
          ? b.used_capital
          : (b.open_positions || []).reduce((acc, p) => acc + Number(p.buy_amount || 0), 0)
      )
    );
    const ratio = Math.max(
      0,
      Number(ratiosMap && ratiosMap[b.bot_id] !== undefined ? ratiosMap[b.bot_id] || 0 : b.allocation_ratio || 0)
    );
    return {
      bot_id: b.bot_id,
      used,
      ratio,
      allocated: 0,
      virtual_krw: 0,
      locked: false,
    };
  });

  const totalUsed = items.reduce((acc, it) => acc + it.used, 0);
  if (flooredTotal <= 0) {
    const byBot = {};
    for (const it of items) {
      byBot[it.bot_id] = { used: it.used, allocated: 0, virtual_krw: 0, ratio: it.ratio };
    }
    return { flooredTotal: 0, totalUsed, totalAllocated: 0, totalVirtual: 0, byBot };
  }

  const totalRatio = Number(items.reduce((acc, it) => acc + it.ratio, 0).toFixed(4));
  const targetPool =
    totalRatio >= 99.99
      ? flooredTotal
      : Math.max(totalUsed, Math.floor(flooredTotal * (totalRatio / 100.0)));

  while (true) {
    const unlocked = items.filter((it) => !it.locked);
    if (unlocked.length === 0) break;

    const lockedAllocatedSum = items
      .filter((it) => it.locked)
      .reduce((acc, it) => acc + it.allocated, 0);
    const remainingPool = Math.max(0, targetPool - lockedAllocatedSum);
    const unlockedRatioSum = unlocked.reduce((acc, it) => acc + it.ratio, 0);

    let anyNewlyLocked = false;
    for (const it of unlocked) {
      const share =
        unlockedRatioSum > 0
          ? Math.floor((remainingPool * it.ratio) / unlockedRatioSum)
          : Math.floor(remainingPool / unlocked.length);
      if (it.used > share) {
        it.allocated = it.used;
        it.virtual_krw = 0;
        it.locked = true;
        anyNewlyLocked = true;
      }
    }

    if (!anyNewlyLocked) {
      let distributed = 0;
      for (const it of unlocked) {
        const share =
          unlockedRatioSum > 0
            ? Math.floor((remainingPool * it.ratio) / unlockedRatioSum)
            : 0;
        it.allocated = share;
        distributed += share;
      }
      const remainder = remainingPool - distributed;
      if (remainder > 0 && unlockedRatioSum > 0) {
        const candidates = [...unlocked]
          .filter((it) => it.ratio > 0)
          .sort((a, b) => b.ratio - a.ratio);
        if (candidates.length > 0) {
          candidates[0].allocated += remainder;
        }
      }
      for (const it of unlocked) {
        it.virtual_krw = Math.max(0, it.allocated - it.used);
        it.locked = true;
      }
      break;
    }
  }

  const byBot = {};
  for (const it of items) {
    byBot[it.bot_id] = {
      used: it.used,
      allocated: it.allocated,
      virtual_krw: it.virtual_krw,
      ratio: it.ratio,
    };
  }

  return {
    flooredTotal,
    totalUsed,
    totalAllocated: items.reduce((acc, it) => acc + it.allocated, 0),
    totalVirtual: items.reduce((acc, it) => acc + it.virtual_krw, 0),
    byBot,
  };
}

function renderColoredProfit(val) {
  const num = Number(val || 0);
  if (num > 0) {
    return <span className="pnl-profit">+{Math.floor(num).toLocaleString("ko-KR")}원</span>;
  }
  if (num < 0) {
    return <span className="pnl-loss">{Math.floor(num).toLocaleString("ko-KR")}원</span>;
  }
  return <span className="pnl-Zero">0원</span>;
}

/**
 * 통계 선 그래프 컴포넌트 (요구사항 10, 11)
 * 2026.10.01부터의 일간/주간/월간 차익 이력을 꺾은선 그래프로 표기
 */
function ProfitLineChart({ series, periodLabel }) {
  const scrollContainerRef = useRef(null);

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollLeft = scrollContainerRef.current.scrollWidth;
    }
  }, [series, periodLabel]);

  if (!series || series.length === 0) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "#94a3b8" }}>
        2026.10.01 이후 집계된 차익 데이터가 없습니다.
      </div>
    );
  }

  const padLeft = 85;
  const padRight = 35;
  const padTop = 45;
  const padBottom = 45;
  const minPointGap = 72;
  const width = Math.max(860, padLeft + padRight + Math.max(0, series.length - 1) * minPointGap);
  const height = 285;

  const getPointValue = (d) => (d.has_trade === false ? 0 : Number(d.cumulative_profit ?? d.profit ?? 0));
  const values = series.map(getPointValue);
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(0, ...values);
  const isAllZero = maxVal === 0 && minVal === 0;
  const rawRange = isAllZero ? 1 : maxVal - minVal;
  // 상하단에 15% 여유를 주어 데이터 포인트 텍스트가 SVG 경계나 축과 겹치지 않게 함
  const range = isAllZero ? 1 : rawRange * 1.25;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const points = series.map((item, idx) => {
    const val = getPointValue(item);
    const x =
      series.length === 1
        ? padLeft + plotW / 2
        : padLeft + (idx / (series.length - 1)) * plotW;
    const y = isAllZero
      ? padTop + plotH / 2
      : padTop + plotH - ((val - minVal) / range) * plotH - (isAllZero ? 0 : plotH * 0.1);
    return { x, y, displayValue: val, ...item };
  });

  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(" ");
  const zeroY = isAllZero
    ? padTop + plotH / 2
    : padTop + plotH - ((0 - minVal) / range) * plotH - (isAllZero ? 0 : plotH * 0.1);
  const showMaxLabel = maxVal > 0 && Math.abs(zeroY - padTop) >= 20;
  const showMinLabel = minVal < 0 && Math.abs(padTop + plotH - zeroY) >= 20;

  return (
    <div>
      <div ref={scrollContainerRef} style={{ width: "100%", overflowX: "auto", paddingBottom: "4px" }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{
            width: series.length > 12 ? `${width}px` : "100%",
            height: series.length > 12 ? `${height}px` : "auto",
            minWidth: "560px",
            display: "block",
          }}
        >
          {/* 기준선 (0원) */}
          <line
            x1={padLeft}
            y1={zeroY}
            x2={width - padRight}
            y2={zeroY}
            stroke="#334155"
            strokeDasharray="4 4"
            strokeWidth="1"
          />
          <text
            x={padLeft - 12}
            y={zeroY + 4}
            textAnchor="end"
            fill="#94a3b8"
            fontSize="11"
          >
            0원
          </text>
          {showMaxLabel && (
            <text
              x={padLeft - 12}
              y={padTop + 4}
              textAnchor="end"
              fill="#94a3b8"
              fontSize="11"
            >
              +{Math.floor(maxVal).toLocaleString()}원
            </text>
          )}
          {showMinLabel && (
            <text
              x={padLeft - 12}
              y={padTop + plotH + 4}
              textAnchor="end"
              fill="#94a3b8"
              fontSize="11"
            >
              {Math.floor(minVal).toLocaleString()}원
            </text>
          )}

          {/* 선 그래프 */}
          <polyline
            fill="none"
            stroke="#6366f1"
            strokeWidth="3"
            points={polylinePoints}
          />

          {/* 데이터 포인트 및 라벨 */}
          {points.map((pt, i) => {
            const val = pt.displayValue;
            const hasTrade = Boolean(pt.has_trade);
            const isPositive = val > 0;
            const isNegative = val < 0;
            const dotColor = !hasTrade
              ? "#64748b"
              : isPositive
              ? "#ef4444"
              : isNegative
              ? "#3b82f6"
              : "#e2e8f0";
            const dotRadius = hasTrade ? 5.5 : 3.5;
            const textColor = !hasTrade ? "#94a3b8" : "#f8fafc";
            const textWeight = hasTrade ? "700" : "500";
            const tooltipText = hasTrade
              ? `${pt.label}: ${Math.floor(val).toLocaleString()}원 (거래 체결 완료)`
              : `${pt.label}: 0원 (거래 없음)`;

            return (
              <g key={pt.label + i} style={{ cursor: "pointer" }}>
                <title>{tooltipText}</title>
                <circle cx={pt.x} cy={pt.y} r={dotRadius} fill={dotColor} stroke="#0b0f19" strokeWidth="2" />
                <text
                  x={pt.x}
                  y={Math.max(18, pt.y - 10)}
                  textAnchor="middle"
                  fill={textColor}
                  fontSize="11"
                  fontWeight={textWeight}
                >
                  {Math.floor(val).toLocaleString()}원
                </text>
                <text
                  x={pt.x}
                  y={height - 14}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="11"
                >
                  {pt.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "6px", textAlign: "right" }}>
        * 통계 시작 기준일: 2026.10.01 ({periodLabel} 차익 추이 · 거래 없는 날은 0원 표기)
      </div>
    </div>
  );
}

/**
 * 월별 보유 자산 및 증감 추이 인터랙티브 차트 컴포넌트
 * - 매달 1일 시점 평가자산 vs 현재/말일 시점 평가자산 막대 그래프 비교
 * - 상단 월간 순증감 뱃지 및 마우스 툴팁 지원
 * - 월별 변동 내역 테이블 표출
 */
function MonthlyAssetGrowthChart({ history, currentMonth, onRefresh, loading }) {
  const scrollRef = useRef(null);
  const [hoveredMonth, setHoveredMonth] = useState(null);

  const dataList = useMemo(() => {
    if (!history || history.length === 0) {
      if (currentMonth) return [currentMonth];
      return [];
    }
    return history;
  }, [history, currentMonth]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [dataList]);

  if (!dataList || dataList.length === 0) {
    return (
      <div style={{ padding: "30px", textAlign: "center", color: "#94a3b8" }}>
        기록된 월별 보유 자산 데이터가 없습니다.
      </div>
    );
  }

  const padLeft = 85;
  const padRight = 40;
  const padTop = 75;
  const padBottom = 50;
  const groupWidth = 156;
  const barWidth = 36;
  const barGap = 12;
  const width = Math.max(820, padLeft + padRight + dataList.length * groupWidth);
  const height = 320;

  const allBalances = dataList.flatMap((d) => [
    Number(d.month_start_balance || 0),
    Number(d.current_balance || 0),
  ]);
  const rawMax = Math.max(...allBalances, 10000);
  const maxVal = Math.ceil(rawMax * 1.35);
  const plotH = height - padTop - padBottom;

  const getY = (val) => {
    const ratio = Math.max(0, Math.min(1, val / maxVal));
    return padTop + plotH - ratio * plotH;
  };

  const formatShortKRW = (num) => {
    if (num >= 100000000) return `${(num / 100000000).toFixed(1)}억`;
    if (num >= 10000) return `${Math.floor(num / 10000).toLocaleString()}만`;
    return `${Math.floor(num).toLocaleString()}원`;
  };

  const yTicks = [0, maxVal * 0.33, maxVal * 0.66, maxVal];

  return (
    <div style={{ marginTop: "10px" }}>
      <div
        ref={scrollRef}
        style={{
          width: "100%",
          overflowX: "auto",
          paddingBottom: "8px",
          background: "rgba(11, 15, 25, 0.4)",
          borderRadius: "12px",
          border: "1px solid rgba(255, 255, 255, 0.05)",
        }}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{
            width: dataList.length > 5 ? `${width}px` : "100%",
            height: "auto",
            minWidth: "600px",
            display: "block",
          }}
        >
          {/* Y축 그리드 및 레이블 */}
          {yTicks.map((tick, idx) => {
            const yPos = getY(tick);
            return (
              <g key={`ytick-${idx}`}>
                <line
                  x1={padLeft}
                  x2={width - padRight}
                  y1={yPos}
                  y2={yPos}
                  stroke={idx === 0 ? "rgba(255, 255, 255, 0.15)" : "rgba(255, 255, 255, 0.05)"}
                  strokeDasharray={idx === 0 ? "none" : "3,3"}
                  strokeWidth="1"
                />
                <text
                  x={padLeft - 10}
                  y={yPos + 4}
                  textAnchor="end"
                  fill="#94a3b8"
                  fontSize="11"
                  fontFamily="sans-serif"
                >
                  {formatShortKRW(tick)}
                </text>
              </g>
            );
          })}

          {/* 월별 막대 그룹 */}
          {dataList.map((item, idx) => {
            const groupCenterX = padLeft + idx * groupWidth + groupWidth / 2;
            const startBal = Number(item.month_start_balance || 0);
            const curBal = Number(item.current_balance || 0);
            const diffAmt = Number(item.diff_amount || curBal - startBal);
            const diffRate = Number(item.diff_rate || 0);
            const isInc = diffAmt > 0;
            const isDec = diffAmt < 0;

            const startBarX = groupCenterX - barWidth - barGap / 2;
            const startBarY = getY(startBal);
            const startBarH = padTop + plotH - startBarY;

            const curBarX = groupCenterX + barGap / 2;
            const curBarY = getY(curBal);
            const curBarH = padTop + plotH - curBarY;

            const topBarY = Math.min(startBarY, curBarY);
            // 막대 상단 금액 텍스트(barY - 8)와 수익 뱃지 간 최소 12px 이상의 여백을 확보하여 겹침 방지
            const badgeY = Math.max(28, topBarY - 40);
            const isHovered = hoveredMonth === item.year_month;

            return (
              <g
                key={item.year_month}
                onMouseEnter={() => setHoveredMonth(item.year_month)}
                onMouseLeave={() => setHoveredMonth(null)}
                style={{ cursor: "pointer" }}
              >
                {/* 배경 호버 하이라이트 영역 */}
                {isHovered && (
                  <rect
                    x={groupCenterX - groupWidth / 2 + 4}
                    y={16}
                    width={groupWidth - 8}
                    height={height - 24}
                    rx="8"
                    fill="rgba(56, 189, 248, 0.06)"
                    stroke="rgba(56, 189, 248, 0.25)"
                    strokeWidth="1"
                  />
                )}

                {/* 1일 시작 자산 막대 (슬레이트 블루) */}
                <rect
                  x={startBarX}
                  y={startBarY}
                  width={barWidth}
                  height={Math.max(2, startBarH)}
                  rx="4"
                  fill="url(#startBalGrad)"
                  opacity={isHovered ? 1 : 0.85}
                />
                <text
                  x={startBarX + barWidth / 2}
                  y={startBarY - 8}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="10"
                  fontWeight="600"
                >
                  {formatShortKRW(startBal)}
                </text>

                {/* 현재/말일 자산 막대 (증가: 에메랄드/그린, 감소: 레드) */}
                <rect
                  x={curBarX}
                  y={curBarY}
                  width={barWidth}
                  height={Math.max(2, curBarH)}
                  rx="4"
                  fill={isInc ? "url(#curBalIncGrad)" : isDec ? "url(#curBalDecGrad)" : "url(#curBalFlatGrad)"}
                  opacity={isHovered ? 1 : 0.95}
                />
                <text
                  x={curBarX + barWidth / 2}
                  y={curBarY - 8}
                  textAnchor="middle"
                  fill={isInc ? "#4ade80" : isDec ? "#f87171" : "#e2e8f0"}
                  fontSize="10.5"
                  fontWeight="700"
                >
                  {formatShortKRW(curBal)}
                </text>

                {/* 상단 증감 뱃지 태그 (수익 표기영역 - 막대 금액 글자와 충분한 간격 유지) */}
                <g transform={`translate(${groupCenterX}, ${badgeY})`}>
                  <rect
                    x="-44"
                    y="-11"
                    width="88"
                    height="22"
                    rx="11"
                    fill={isInc ? "rgba(34, 197, 94, 0.22)" : isDec ? "rgba(239, 68, 68, 0.22)" : "rgba(148, 163, 184, 0.2)"}
                    stroke={isInc ? "#22c55e" : isDec ? "#ef4444" : "#94a3b8"}
                    strokeWidth="1.2"
                  />
                  <text
                    x="0"
                    y="0"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={isInc ? "#4ade80" : isDec ? "#fca5a5" : "#cbd5e1"}
                    fontSize="10"
                    fontWeight="800"
                  >
                    {isInc ? `▲ +${diffRate.toFixed(1)}%` : isDec ? `▼ ${diffRate.toFixed(1)}%` : "- 0.0%"}
                  </text>
                </g>

                {/* X축 연월 라벨 */}
                <text
                  x={groupCenterX}
                  y={height - 20}
                  textAnchor="middle"
                  fill={isHovered ? "#38bdf8" : "#cbd5e1"}
                  fontSize="12"
                  fontWeight={isHovered ? "800" : "600"}
                >
                  {item.year_month}
                </text>
                <text
                  x={groupCenterX}
                  y={height - 6}
                  textAnchor="middle"
                  fill="#64748b"
                  fontSize="10"
                >
                  {item.year_month === currentMonth?.year_month ? "(진행중)" : "(마감)"}
                </text>
              </g>
            );
          })}

          {/* 그라데이션 정의 */}
          <defs>
            <linearGradient id="startBalGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#64748b" />
              <stop offset="100%" stopColor="#334155" />
            </linearGradient>
            <linearGradient id="curBalIncGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" />
              <stop offset="100%" stopColor="#047857" />
            </linearGradient>
            <linearGradient id="curBalDecGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" />
              <stop offset="100%" stopColor="#b91c1c" />
            </linearGradient>
            <linearGradient id="curBalFlatGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#94a3b8" />
              <stop offset="100%" stopColor="#475569" />
            </linearGradient>
          </defs>
        </svg>
      </div>

      {/* 범례 (Legend) */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "10px",
          marginTop: "12px",
          padding: "8px 12px",
          background: "rgba(15, 23, 42, 0.5)",
          borderRadius: "8px",
          fontSize: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span style={{ width: "12px", height: "12px", background: "#64748b", borderRadius: "3px", display: "inline-block" }} />
            <span style={{ color: "#cbd5e1" }}>1일 시점 평가자산</span>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span style={{ width: "12px", height: "12px", background: "#10b981", borderRadius: "3px", display: "inline-block" }} />
            <span style={{ color: "#cbd5e1" }}>현재/말일 자산 (자산 증가)</span>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span style={{ width: "12px", height: "12px", background: "#ef4444", borderRadius: "3px", display: "inline-block" }} />
            <span style={{ color: "#cbd5e1" }}>현재/말일 자산 (자산 감소)</span>
          </span>
        </div>
        {onRefresh && (
          <button
            type="button"
            className="btn btn-outline"
            onClick={onRefresh}
            disabled={loading}
            style={{ padding: "4px 10px", fontSize: "11.5px" }}
          >
            {loading ? "동기화 중..." : "🔄 자산 스냅샷 동기화"}
          </button>
        )}
      </div>

      {/* 월별 보유 자산 변동 원장 테이블 */}
      <div style={{ marginTop: "14px", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
          <thead>
            <tr style={{ background: "rgba(30, 41, 59, 0.8)", borderBottom: "1px solid rgba(255, 255, 255, 0.1)" }}>
              <th style={{ padding: "8px 10px", textAlign: "left", color: "#94a3b8" }}>기준 연월</th>
              <th style={{ padding: "8px 10px", textAlign: "right", color: "#94a3b8" }}>1일 시점 자산</th>
              <th style={{ padding: "8px 10px", textAlign: "right", color: "#94a3b8" }}>현재/말일 자산</th>
              <th style={{ padding: "8px 10px", textAlign: "right", color: "#94a3b8" }}>원화 잔고</th>
              <th style={{ padding: "8px 10px", textAlign: "right", color: "#94a3b8" }}>코인 평가액</th>
              <th style={{ padding: "8px 10px", textAlign: "right", color: "#94a3b8" }}>월간 증감액</th>
              <th style={{ padding: "8px 10px", textAlign: "right", color: "#94a3b8" }}>증감률</th>
              <th style={{ padding: "8px 10px", textAlign: "center", color: "#94a3b8" }}>증감 상태</th>
            </tr>
          </thead>
          <tbody>
            {dataList.map((row) => {
              const diff = Number(row.diff_amount || 0);
              const rate = Number(row.diff_rate || 0);
              const isInc = diff > 0;
              const isDec = diff < 0;
              return (
                <tr
                  key={row.year_month}
                  style={{
                    borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
                    background: row.year_month === currentMonth?.year_month ? "rgba(56, 189, 248, 0.05)" : "transparent",
                  }}
                >
                  <td style={{ padding: "8px 10px", fontWeight: "700", color: "#f8fafc" }}>
                    {row.year_month}
                    {row.year_month === currentMonth?.year_month && (
                      <span style={{ marginLeft: "6px", fontSize: "11px", color: "#38bdf8" }}>(이번달)</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: "#cbd5e1" }}>
                    {Math.floor(Number(row.month_start_balance || 0)).toLocaleString("ko-KR")}원
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: "700", color: "#f8fafc" }}>
                    {Math.floor(Number(row.current_balance || 0)).toLocaleString("ko-KR")}원
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: "#94a3b8" }}>
                    {Math.floor(Number(row.krw_balance || 0)).toLocaleString("ko-KR")}원
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: "#94a3b8" }}>
                    {Math.floor(Number(row.coin_eval_balance || 0)).toLocaleString("ko-KR")}원
                  </td>
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      fontWeight: "700",
                      color: isInc ? "#4ade80" : isDec ? "#f87171" : "#cbd5e1",
                    }}
                  >
                    {isInc ? "+" : ""}
                    {Math.floor(diff).toLocaleString("ko-KR")}원
                  </td>
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      fontWeight: "700",
                      color: isInc ? "#4ade80" : isDec ? "#f87171" : "#cbd5e1",
                    }}
                  >
                    {isInc ? "+" : ""}
                    {rate.toFixed(2)}%
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "center" }}>
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: "6px",
                        fontSize: "11px",
                        fontWeight: "700",
                        background: isInc
                          ? "rgba(34, 197, 94, 0.15)"
                          : isDec
                          ? "rgba(239, 68, 68, 0.15)"
                          : "rgba(148, 163, 184, 0.15)",
                        color: isInc ? "#4ade80" : isDec ? "#f87171" : "#cbd5e1",
                        border: `1px solid ${isInc ? "rgba(34, 197, 94, 0.3)" : isDec ? "rgba(239, 68, 68, 0.3)" : "rgba(148, 163, 184, 0.3)"}`,
                      }}
                    >
                      {isInc ? "▲ 금액 증가" : isDec ? "▼ 금액 감소" : "- 보합 유지"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MarkdownViewer({ content, isStreaming = false }) {
  if (!content) return null;
  const lines = content.split("\n");
  const elements = [];
  let currentList = [];

  const flushList = () => {
    if (currentList.length > 0) {
      elements.push(
        <ul key={`ul-${elements.length}`} style={{ margin: "8px 0 12px 20px", paddingLeft: "10px", lineHeight: "1.7" }}>
          {currentList.map((item, idx) => (
            <li key={idx} style={{ marginBottom: "4px", color: "#e2e8f0" }}>{renderFormattedText(item)}</li>
          ))}
        </ul>
      );
      currentList = [];
    }
  };

  const renderFormattedText = (text) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={i} style={{ color: "#38bdf8", fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
      }
      return part;
    });
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    if (line.startsWith("- ") || line.startsWith("* ")) {
      currentList.push(line.slice(2));
      return;
    }
    flushList();

    if (line.startsWith("### ")) {
      elements.push(
        <h4 key={index} style={{ fontSize: "15px", fontWeight: 700, color: "#cbd5e1", margin: "14px 0 6px" }}>
          {renderFormattedText(line.slice(4))}
        </h4>
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <h3 key={index} style={{ fontSize: "16px", fontWeight: 700, color: "#f8fafc", margin: "18px 0 8px", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: "6px" }}>
          {renderFormattedText(line.slice(3))}
        </h3>
      );
    } else if (line.startsWith("# ")) {
      elements.push(
        <h2 key={index} style={{ fontSize: "18px", fontWeight: 800, color: "#38bdf8", margin: "20px 0 10px" }}>
          {renderFormattedText(line.slice(2))}
        </h2>
      );
    } else if (line.trim().length === 0) {
      elements.push(<div key={index} style={{ height: "6px" }} />);
    } else {
      elements.push(
        <p key={index} style={{ margin: "4px 0", lineHeight: "1.65", color: "#cbd5e1" }}>
          {renderFormattedText(line)}
        </p>
      );
    }
  });

  flushList();
  return (
    <div style={{ fontSize: "13.5px", color: "#e2e8f0" }}>
      {elements}
      {isStreaming && (
        <span
          style={{
            display: "inline-block",
            width: "3px",
            height: "14px",
            backgroundColor: "#38bdf8",
            marginLeft: "4px",
            verticalAlign: "middle",
            animation: "cursorBlink 0.8s infinite",
          }}
        />
      )}
    </div>
  );
}

function getTodayKSTDateString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isDailyGateAuthValid() {
  const today = getTodayKSTDateString();
  const hasAuth =
    sessionStorage.getItem("autoCoinTrade_auth") === "true" ||
    localStorage.getItem("autoCoinTrade_auth") === "true";
  const savedDate =
    localStorage.getItem("autoCoinTrade_auth_date") ||
    sessionStorage.getItem("autoCoinTrade_auth_date") ||
    "";
  if (!hasAuth || savedDate !== today) {
    sessionStorage.removeItem("autoCoinTrade_auth");
    localStorage.removeItem("autoCoinTrade_auth");
    sessionStorage.removeItem("autoCoinTrade_auth_date");
    localStorage.removeItem("autoCoinTrade_auth_date");
    return false;
  }
  return true;
}

function renderSimpleMarkdown(md) {
  if (!md) return "";
  const lines = md.split(/\r?\n/);
  const out = [];
  let inTable = false;
  let tableHeader = [];
  let tableRows = [];

  const flushTable = () => {
    if (inTable) {
      out.push(
        `<table class="history-table"><thead><tr>${tableHeader
          .map((th) => `<th>${th}</th>`)
          .join("")}</tr></thead><tbody>${tableRows
          .map((row) => `<tr>${row.map((td) => `<td>${td}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
      );
      inTable = false;
      tableHeader = [];
      tableRows = [];
    }
  };

  const inlineFormat = (text) => {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => inlineFormat(c.trim()));
      if (cells.every((c) => /^:?-+:?$/.test(c.replace(/&lt;|&gt;/g, "")))) {
        continue;
      }
      if (!inTable) {
        inTable = true;
        tableHeader = cells;
      } else {
        tableRows.push(cells);
      }
      continue;
    } else {
      flushTable();
    }

    if (!trimmed) {
      out.push("<div style='height: 8px;'></div>");
      continue;
    }

    if (trimmed.startsWith("### ")) {
      out.push(`<h3>${inlineFormat(trimmed.slice(4))}</h3>`);
    } else if (trimmed.startsWith("## ")) {
      out.push(`<h2>${inlineFormat(trimmed.slice(3))}</h2>`);
    } else if (trimmed.startsWith("# ")) {
      out.push(`<h1>${inlineFormat(trimmed.slice(2))}</h1>`);
    } else if (trimmed.startsWith("> ")) {
      out.push(`<blockquote>${inlineFormat(trimmed.slice(2))}</blockquote>`);
    } else if (trimmed.startsWith("---")) {
      out.push("<hr style='border:none; border-top:1px solid rgba(255,255,255,0.1); margin:16px 0;' />");
    } else if (trimmed.startsWith("- ")) {
      out.push(`<div style='padding-left:16px; margin:3px 0;'>• ${inlineFormat(trimmed.slice(2))}</div>`);
    } else if (trimmed.startsWith("  - ")) {
      out.push(`<div style='padding-left:32px; margin:2px 0; color:#94a3b8;'>◦ ${inlineFormat(trimmed.slice(4))}</div>`);
    } else if (trimmed.startsWith("    - ")) {
      out.push(`<div style='padding-left:48px; margin:2px 0; color:#64748b;'>▪ ${inlineFormat(trimmed.slice(6))}</div>`);
    } else {
      out.push(`<p style='margin: 4px 0;'>${inlineFormat(trimmed)}</p>`);
    }
  }
  flushTable();

  return out.join("\n");
}

export default function App() {
  // 1) 입장 코드 인증 상태 (날짜 변경 시 자동 만료 및 재인증 요구)
  const [authenticated, setAuthenticated] = useState(() => isDailyGateAuthValid());
  const [entryCodeInput, setEntryCodeInput] = useState("");
  const [gateError, setGateError] = useState("");

  // 프로젝트 버전 및 히스토리 모달 상태
  const [appVersion, setAppVersion] = useState("0.0.20");
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyContent, setHistoryContent] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);

  // 1-1) 초기 설정 마법사 (Setup Wizard) 상태
  const [setupConfigured, setSetupConfigured] = useState(true);
  const [setupChecking, setSetupChecking] = useState(true);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);

  // 마법사 폼 데이터
  const [wizardForm, setWizardForm] = useState({
    entryCode: "stock",
    tradeMode: "paper",
    initialCapital: 10000000,
    dbType: "sqlite",
    dbConfig: {
      host: "127.0.0.1",
      port: 5432,
      database: "coin_trader",
      user: "coin_trader",
      password: "",
    },
    upbitAccessKey: "",
    upbitSecretKey: "",
    skipUpbit: false,
    geminiApiKey: "",
  });

  const [dbTestState, setDbTestState] = useState({ loading: false, result: null, error: null });
  const [keysTestState, setKeysTestState] = useState({ loading: false, result: null, error: null });
  const [installState, setInstallState] = useState({
    installing: false,
    progress: 0,
    currentStepIndex: 0,
    error: null,
  });

  const fetchSetupStatus = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/setup/status`);
      if (resp.ok) {
        const data = await resp.json();
        setSetupConfigured(data.is_configured);
        if (data.is_configured) {
          setShowSetupWizard(false);
        }
        if (data.version) {
          setAppVersion(data.version);
        }
        if (data.current_env) {
          setWizardForm((prev) => ({
            ...prev,
            tradeMode: data.current_env.trade_mode || "paper",
            initialCapital: data.current_env.initial_capital || 10000000,
            dbType: data.current_env.db_mode === "postgres_hybrid" ? "server" : "sqlite",
            dbConfig: {
              ...prev.dbConfig,
              ...(data.current_env.db_config || {}),
            },
          }));
        }
      }
    } catch (err) {
      console.warn("Setup status fetch error:", err.message);
    } finally {
      setSetupChecking(false);
    }
  }, []);

  const openHistoryModal = useCallback(async () => {
    setHistoryModalOpen(true);
    if (!historyContent) {
      setHistoryLoading(true);
      try {
        const resp = await fetch(`${API_BASE}/api/version/history`);
        const data = await resp.json();
        if (data && data.history) {
          setHistoryContent(data.history);
        } else {
          setHistoryContent("버전 변경 이력(history.md)을 불러올 수 없습니다.");
        }
      } catch (err) {
        setHistoryContent(`버전 변경 이력 로드 오류: ${err.message}`);
      } finally {
        setHistoryLoading(false);
      }
    }
  }, [historyContent]);

  useEffect(() => {
    fetchSetupStatus();
    fetch(`${API_BASE}/api/version`)
      .then((r) => r.json())
      .then((data) => {
        if (data && data.version) {
          setAppVersion(data.version);
        }
      })
      .catch(() => {});
  }, [fetchSetupStatus]);

  const handleTestDbConnection = async () => {
    setDbTestState({ loading: true, result: null, error: null });
    try {
      const resp = await fetch(`${API_BASE}/api/setup/test-db`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wizardForm.dbConfig),
      });
      const data = await resp.json();
      if (data.ok) {
        setDbTestState({ loading: false, result: data.message, error: null });
      } else {
        setDbTestState({ loading: false, result: null, error: data.error || "DB 서버에 연결할 수 없습니다." });
      }
    } catch (err) {
      setDbTestState({ loading: false, result: null, error: `네트워크 오류: ${err.message}` });
    }
  };

  const handleTestApiKeys = async () => {
    setKeysTestState({ loading: true, result: null, error: null });
    try {
      const resp = await fetch(`${API_BASE}/api/setup/test-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upbit_access_key: wizardForm.upbitAccessKey,
          upbit_secret_key: wizardForm.upbitSecretKey,
          gemini_api_key: wizardForm.geminiApiKey,
          skip_upbit: wizardForm.skipUpbit,
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        setKeysTestState({
          loading: false,
          result: `${data.upbit?.message || "업비트 검증 통과"} | ${data.gemini?.message || "Gemini 검증 통과"}`,
          error: null,
        });
      } else {
        const errors = [];
        if (!data.upbit?.ok) errors.push(`[업비트] ${data.upbit?.error || "검증 실패"}`);
        if (!data.gemini?.ok) errors.push(`[Gemini] ${data.gemini?.error || "검증 실패"}`);
        setKeysTestState({
          loading: false,
          result: null,
          error: errors.join(" / ") || "API 키 검증에 실패했습니다.",
        });
      }
    } catch (err) {
      setKeysTestState({ loading: false, result: null, error: `네트워크 오류: ${err.message}` });
    }
  };

  const handleCompleteSetup = async () => {
    setInstallState({ installing: true, progress: 15, currentStepIndex: 0, error: null });

    try {
      await new Promise((r) => setTimeout(r, 400));
      setInstallState((prev) => ({ ...prev, progress: 35, currentStepIndex: 1 }));

      const resp = await fetch(`${API_BASE}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry_code: wizardForm.entryCode,
          trade_mode: wizardForm.tradeMode,
          initial_capital: wizardForm.initialCapital,
          db_type: wizardForm.dbType,
          db_config: wizardForm.dbConfig,
          upbit_access_key: wizardForm.upbitAccessKey,
          upbit_secret_key: wizardForm.upbitSecretKey,
          gemini_api_key: wizardForm.geminiApiKey,
          skip_upbit: wizardForm.skipUpbit,
        }),
      });

      setInstallState((prev) => ({ ...prev, progress: 65, currentStepIndex: 2 }));
      await new Promise((r) => setTimeout(r, 400));
      setInstallState((prev) => ({ ...prev, progress: 85, currentStepIndex: 3 }));

      const data = await resp.json();
      if (resp.ok && data.ok) {
        setInstallState((prev) => ({ ...prev, progress: 100, currentStepIndex: 4 }));
        await new Promise((r) => setTimeout(r, 500));

        const today = new Date().toISOString().slice(0, 10);
        sessionStorage.setItem("autoCoinTrade_auth", "true");
        localStorage.setItem("autoCoinTrade_auth", "true");
        sessionStorage.setItem("autoCoinTrade_auth_date", today);
        localStorage.setItem("autoCoinTrade_auth_date", today);

        setAuthenticated(true);
        setSetupConfigured(true);
        setShowSetupWizard(false);
        setInstallState({ installing: false, progress: 0, currentStepIndex: 0, error: null });

        fetchOverviewAndBots(true);
        fetchUpbitStatus();
        fetchTradeMode();
        fetchEntryCode();
      } else {
        setInstallState((prev) => ({
          ...prev,
          installing: false,
          error: data.message || "설치 진행 중 오류가 발생했습니다.",
        }));
      }
    } catch (err) {
      setInstallState((prev) => ({
        ...prev,
        installing: false,
        error: `서버 통신 오류: ${err.message}`,
      }));
    }
  };

  // 2) 좌측 메뉴 상태 (실제거래 현황 | 가상거래 경쟁 | 통계 | 뉴스 | 설정)
  const [activeMenu, setActiveMenu] = useState(() => {
    const saved =
      sessionStorage.getItem("autoCoinTrade_menu") ||
      localStorage.getItem("autoCoinTrade_menu") ||
      "trades";
    return saved === "algo-lab" ? "arena" : saved;
  });

  // 3) 업비트 통신 상태 (요구사항 19: 정상 초록 / 지연 노랑 / 불가 빨강 + 이유 툴팁)
  const [upbitStatus, setUpbitStatus] = useState({
    status: "green",
    label: "정상통신",
    latency_ms: 45,
    reason: "업비트 Open API 통신 상태 확인 중...",
    checked_at: "",
  });

  // 4) 봇 목록, 거래 내역, 통계, 자금 분배 상태
  const [bots, setBots] = useState([]);
  const [selectedBotId, setSelectedBotId] = useState(() => {
    const saved =
      sessionStorage.getItem("autoCoinTrade_bot") ||
      localStorage.getItem("autoCoinTrade_bot") ||
      "bot_01";
    if (saved === "bot_volatility") return "bot_01";
    if (saved === "bot_dual_momentum") return "bot_03";
    if (saved === "bot_bollinger_reversal") return "bot_05";
    return saved;
  });
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState({
    start_date: "2026.10.01",
    daily: [],
    weekly: [],
    monthly: [],
    coin_ranking: [],
    monthly_assets: null,
  });
  const [statsPeriodTab, setStatsPeriodTab] = useState(() => {
    return (
      sessionStorage.getItem("autoCoinTrade_statsTab") ||
      localStorage.getItem("autoCoinTrade_statsTab") ||
      "daily"
    );
  });

  // 5) 설정 화면용 상태 (기본값 없음)
  const [totalCapitalInput, setTotalCapitalInput] = useState("");
  const [ratioInputs, setRatioInputs] = useState({});
  const [botEditForms, setBotEditForms] = useState({});
  const [upbitAccount, setUpbitAccount] = useState({
    loading: false,
    success: false,
    krw_balance: null,
    orderable_krw: null,
    total_buy_krw: null,
    total_eval_krw: null,
    total_asset_krw: null,
    eval_profit_krw: null,
    eval_profit_pct: null,
    krw_locked: null,
    krw_total: null,
    message: "",
    checked_at: "",
  });
  const fileInputRef = useRef(null);

  // 입장 코드 관리 상태 (기본: stock)
  const [entryCodeSetting, setEntryCodeSetting] = useState("");
  const [newEntryCodeInput, setNewEntryCodeInput] = useState("");
  const [newEntryCodeConfirm, setNewEntryCodeConfirm] = useState("");
  const [entryCodeMsg, setEntryCodeMsg] = useState(null);
  const [entryCodeLoading, setEntryCodeLoading] = useState(false);
  const [showEntryCode, setShowEntryCode] = useState(false);

  // 6) Modal Popup 상태 (요구사항 20: 거래 시작/중지 모달, 요구사항 21: 잔고 0 이하 중지 알림 모달)
  const [modalInfo, setModalInfo] = useState({
    open: false,
    title: "",
    message: "",
    type: "info",
  });
  const [zeroBalanceAlerted, setZeroBalanceAlerted] = useState(false);

  // 7) AI 실시간 마켓 브리핑 상태 (Gemini 3.5 Flash)
  const [aiBriefing, setAiBriefing] = useState({
    has_key: false,
    masked_key: "",
    latest: null,
    last_trigger_type: "MANUAL",
  });
  const [geminiQuota, setGeminiQuota] = useState({
    daily_total_limit: 20,
    auto_reserved_count: 6,
    manual_limit: 14,
    manual_used: 0,
    auto_used: 0,
    remaining_calls: 14,
    schedule_hours: [0, 4, 8, 12, 16, 20],
    next_scheduled_at: "",
  });
  const [geminiQuotaNotice, setGeminiQuotaNotice] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiKeyInput, setAiKeyInput] = useState("");
  const [showAiKeyConfig, setShowAiKeyConfig] = useState(false);
  const [isAiBriefingExpanded, setIsAiBriefingExpanded] = useState(false);

  // 실시간 스트리밍 & 한 글자씩 타이핑(Typewriter) 상태
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingMeta, setStreamingMeta] = useState(null);
  const typewriterQueueRef = useRef("");
  const typingTimerRef = useRef(null);
  const isStreamDoneRef = useRef(false);
  const isAiBusyRef = useRef(false);
  const activeStreamAbortControllerRef = useRef(null);

  // 7-1) AI 주간 봇 자동 추천 & 편성 상태 (1주일 주기)
  const [weeklyBotSelection, setWeeklyBotSelection] = useState({
    has_selection: false,
    last_run: null,
    next_scheduled_run: null,
    days_remaining: 7,
    selection: null,
  });
  const [weeklyBotLoading, setWeeklyBotLoading] = useState(false);
  const [isWeeklyBotExpanded, setIsWeeklyBotExpanded] = useState(true);

  // 8) 뉴스 피드 상태 (요구사항: 50건 페이지네이션, 날짜/키워드 검색)
  const [newsList, setNewsList] = useState([]);
  const [newsTotal, setNewsTotal] = useState(0);
  const [newsPage, setNewsPage] = useState(1);
  const [newsTotalPages, setNewsTotalPages] = useState(1);
  const [newsKeyword, setNewsKeyword] = useState("");
  const [newsStartDate, setNewsStartDate] = useState("");
  const [newsEndDate, setNewsEndDate] = useState("");
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsRefreshing, setNewsRefreshing] = useState(false);
  const [newsNotice, setNewsNotice] = useState("");

  // 9) 뉴스 기반 AI 종합 판단 및 실시간 스트리밍 상태 (요구사항: 접을 수 있는 영역, 한 글자씩 스트리밍 타이핑)
  const [isNewsAiExpanded, setIsNewsAiExpanded] = useState(true);
  const [newsAiLoading, setNewsAiLoading] = useState(false);
  const [isNewsStreaming, setIsNewsStreaming] = useState(false);
  const [newsStreamingText, setNewsStreamingText] = useState("");
  const [newsStreamingMeta, setNewsStreamingMeta] = useState(null);
  const [newsAiBriefing, setNewsAiBriefing] = useState({
    has_key: false,
    masked_key: "",
    latest: null,
    last_trigger_type: "MANUAL",
  });
  const newsTypewriterQueueRef = useRef("");
  const newsTypingTimerRef = useRef(null);
  const isNewsStreamDoneRef = useRef(false);
  const isNewsAiBusyRef = useRef(false);
  const activeNewsStreamAbortControllerRef = useRef(null);

  // 10) 웹푸시(Web Push) 알림 상태
  const [notificationPermission, setNotificationPermission] = useState(
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "default"
  );
  const [isPushSubscribed, setIsPushSubscribed] = useState(false);
  const [pushToast, setPushToast] = useState({ show: false, title: "", message: "" });
  const lastBriefingIdRef = useRef(null);
  const lastPushNotifiedTimeRef = useRef(0);

  // 뉴스 AI 한 글자씩 부드럽게 화면에 타이핑해주는 이펙트
  useEffect(() => {
    if (!isNewsStreaming) {
      if (newsTypingTimerRef.current) clearInterval(newsTypingTimerRef.current);
      return;
    }

    newsTypingTimerRef.current = setInterval(() => {
      if (newsTypewriterQueueRef.current.length > 0) {
        const qLen = newsTypewriterQueueRef.current.length;
        const take = qLen > 80 ? 4 : qLen > 30 ? 2 : 1;
        const nextChars = newsTypewriterQueueRef.current.slice(0, take);
        newsTypewriterQueueRef.current = newsTypewriterQueueRef.current.slice(take);
        setNewsStreamingText((prev) => prev + nextChars);
      } else if (isNewsStreamDoneRef.current) {
        clearInterval(newsTypingTimerRef.current);
        setIsNewsStreaming(false);
      }
    }, 18);

    return () => {
      if (newsTypingTimerRef.current) clearInterval(newsTypingTimerRef.current);
    };
  }, [isNewsStreaming]);

  // 한 글자씩 부드럽게 화면에 타이핑해주는 이펙트
  useEffect(() => {
    if (!isStreaming) {
      if (typingTimerRef.current) clearInterval(typingTimerRef.current);
      return;
    }

    typingTimerRef.current = setInterval(() => {
      if (typewriterQueueRef.current.length > 0) {
        const qLen = typewriterQueueRef.current.length;
        // 큐 크기에 따라 1~4글자씩 꺼내어 지연 없이 부드럽게 한 글자씩 타이핑
        const take = qLen > 80 ? 4 : qLen > 30 ? 2 : 1;
        const nextChars = typewriterQueueRef.current.slice(0, take);
        typewriterQueueRef.current = typewriterQueueRef.current.slice(take);
        setStreamingText((prev) => prev + nextChars);
      } else if (isStreamDoneRef.current) {
        clearInterval(typingTimerRef.current);
        setIsStreaming(false);
      }
    }, 18);

    return () => {
      if (typingTimerRef.current) clearInterval(typingTimerRef.current);
    };
  }, [isStreaming]);

  // 컴포넌트 언마운트 시 활성 스트리밍 요청 정리
  useEffect(() => {
    return () => {
      if (activeStreamAbortControllerRef.current) {
        activeStreamAbortControllerRef.current.abort();
      }
      if (activeNewsStreamAbortControllerRef.current) {
        activeNewsStreamAbortControllerRef.current.abort();
      }
    };
  }, []);

  const showModal = (title, message, type = "info") => {
    setModalInfo({ open: true, title, message, type });
  };

  const closeModal = () => {
    setModalInfo((prev) => ({ ...prev, open: false }));
  };

  const renderHistoryModal = () => {
    if (!historyModalOpen) return null;
    return (
      <div className="modal-backdrop" onClick={() => setHistoryModalOpen(false)}>
        <div className="history-modal-box" onClick={(e) => e.stopPropagation()}>
          <div className="history-modal-header">
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "20px" }}>📜</span>
              <div>
                <strong style={{ fontSize: "16px", color: "#f8fafc" }}>
                  autoCoinTrade 프로젝트 변경 이력 (History)
                </strong>
                <span
                  className="version-pill-badge"
                  style={{ marginLeft: "10px", fontSize: "11px" }}
                >
                  현재 v{appVersion}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-outline"
              style={{ padding: "4px 10px", fontSize: "12px" }}
              onClick={() => setHistoryModalOpen(false)}
            >
              닫기 ✕
            </button>
          </div>
          <div className="history-modal-body">
            {historyLoading ? (
              <div style={{ padding: "40px", textAlign: "center", color: "#94a3b8" }}>
                ⏳ 버전 변경 내역(history.md)을 불러오는 중입니다...
              </div>
            ) : (
              <div
                dangerouslySetInnerHTML={{
                  __html: renderSimpleMarkdown(historyContent),
                }}
              />
            )}
          </div>
          <div
            style={{
              padding: "12px 24px",
              borderTop: "1px solid rgba(255, 255, 255, 0.08)",
              background: "rgba(15, 23, 42, 0.95)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "12px",
              color: "#64748b",
              flexWrap: "wrap",
              gap: "10px",
            }}
          >
            <span>* 별다른 언급이 없다면 git commit 1건당 0.0.X 증가 규칙이 유지됩니다.</span>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: "6px 16px", fontSize: "12.5px" }}
              onClick={() => setHistoryModalOpen(false)}
            >
              확인 완료
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Web Audio 소리 알림 (신호음)
  const playNotificationChime = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {}
  }, []);

  const urlBase64ToUint8Array = (base64String) => {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  };

  // 서비스 워커 등록 및 VAPID 푸시 구독
  const registerAndSubscribePush = useCallback(async (promptUser = false) => {
    if (!("Notification" in window)) {
      if (promptUser) {
        showModal("알림 미지원", "현재 브라우저는 웹 알림(Web Push)을 지원하지 않습니다.", "warning");
      }
      return false;
    }

    let perm = Notification.permission;
    if (perm === "default" && promptUser) {
      try {
        perm = await Notification.requestPermission();
        setNotificationPermission(perm);
      } catch (e) {
        console.warn("Permission request failed:", e);
      }
    }

    if (perm !== "granted") {
      if (promptUser && perm === "denied") {
        showModal(
          "웹푸시 권한 차단됨",
          "브라우저 설정에서 알림 권한이 차단되어 있습니다. 주소창 좌측 사이트 설정(자물쇠 아이콘)에서 알림을 허용으로 변경해주세요.",
          "warning"
        );
      }
      return false;
    }

    setNotificationPermission("granted");

    if ("serviceWorker" in navigator) {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;

        if ("PushManager" in window && registration.pushManager) {
          try {
            const vapidResp = await fetch(`${API_BASE}/api/push/vapid-public-key`);
            if (vapidResp.ok) {
              const { publicKey } = await vapidResp.json();
              if (publicKey) {
                let subscription = await registration.pushManager.getSubscription();
                if (!subscription) {
                  subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(publicKey),
                  });
                }
                await fetch(`${API_BASE}/api/push/subscribe`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    subscription: subscription.toJSON(),
                    userAgent: navigator.userAgent,
                  }),
                });
                setIsPushSubscribed(true);
              }
            }
          } catch (e) {
            console.warn("PushManager subscription warning:", e);
          }
        }
        return true;
      } catch (swErr) {
        console.warn("ServiceWorker registration warning:", swErr);
      }
    }
    return true;
  }, []);

  // 웹푸시 알림 표시 (Service Worker + Notification API + 사운드 + 인앱 토스트)
  const showWebPushNotification = useCallback(
    async (title = "AI 뉴스 분석 완료", body = "ai 분석이 완료되었습니다", options = {}) => {
      // 중복 방지 (최근 2초 이내 동일 알림 방지)
      const now = Date.now();
      if (now - lastPushNotifiedTimeRef.current < 2000 && options.tag === "ai-news-analysis-done") {
        return;
      }
      lastPushNotifiedTimeRef.current = now;

      // 1. 소리 알림
      playNotificationChime();

      // 2. 인앱 토스트 팝업 (5초)
      setPushToast({
        show: true,
        title,
        message: body,
      });
      setTimeout(() => {
        setPushToast((prev) => ({ ...prev, show: false }));
      }, 5000);

      // 3. 브라우저 OS 알림 발송
      if (!("Notification" in window) || Notification.permission !== "granted") {
        return;
      }

      const notifOptions = {
        body,
        icon: "/coin-icon.svg",
        badge: "/coin-icon.svg",
        tag: options.tag || "ai-news-analysis-done",
        renotify: true,
        data: {
          url: "/?menu=news",
          timestamp: now,
          ...options.data,
        },
        ...options,
      };

      // Service Worker showNotification 우선 시도 (백그라운드/모바일 최적화)
      if ("serviceWorker" in navigator) {
        try {
          const reg = await navigator.serviceWorker.ready;
          if (reg && reg.showNotification) {
            await reg.showNotification(title, notifOptions);
            return;
          }
        } catch (e) {
          console.warn("SW showNotification error, falling back:", e);
        }
      }

      // 일반 Notification 인스턴스 폴백
      try {
        const notif = new Notification(title, notifOptions);
        notif.onclick = () => {
          window.focus();
          setActiveMenu("news");
          notif.close();
        };
      } catch (e) {
        console.warn("Desktop Notification constructor error:", e);
      }
    },
    [playNotificationChime]
  );

  // 10) 거래 모드 상태 (가상거래 모의투자 'paper' vs 실거래 'live')
  const [tradeMode, setTradeMode] = useState({
    mode: "live",
    is_live: true,
    has_keys: true,
    loading: false,
    message: "",
  });

  const fetchTradeMode = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/trade-mode`);
      if (!resp.ok) return;
      const data = await resp.json();
      setTradeMode((prev) => ({
        ...prev,
        mode: data.mode || "live",
        is_live: !!data.is_live,
        has_keys: !!data.has_keys,
        message: data.message || "",
      }));
    } catch {}
  }, []);

  const fetchEntryCode = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/settings/entry-code`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.success && data.entry_code) {
        setEntryCodeSetting(data.entry_code);
        setNewEntryCodeInput(data.entry_code);
      }
    } catch (err) {
      console.warn("Failed to fetch entry code:", err);
    }
  }, []);

  const handleToggleTradeMode = async (targetMode) => {
    const nextMode = targetMode || (tradeMode.mode === "live" ? "paper" : "live");
    const confirmMsg =
      nextMode === "live"
        ? "⚠️ [실거래 모드]로 전환하시겠습니까?\n실제 업비트 계좌의 자금으로 실제 매수/매도 주문이 전송됩니다."
        : "🧪 [가상거래(모의투자) 모드]로 전환하시겠습니까?\n실제 코인 시세와 호가를 바탕으로 모의 체결이 이루어지며, 실제 계좌 잔고는 소진되지 않습니다.";
    if (!window.confirm(confirmMsg)) return;

    setTradeMode((prev) => ({ ...prev, loading: true }));
    try {
      const resp = await fetch(`${API_BASE}/api/trade-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: nextMode }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setTradeMode((prev) => ({
          ...prev,
          mode: data.mode,
          is_live: data.mode === "live" && prev.has_keys,
          loading: false,
          message: data.message,
        }));
        showModal(
          data.mode === "live" ? "⚡ 실거래 모드 전환 완료" : "🧪 가상거래 모드 전환 완료",
          data.message,
          data.mode === "live" ? "warning" : "info"
        );
        fetchOverviewAndBots(false, data.mode);
        fetchTrades(selectedBotId, data.mode);
        fetchStatistics(data.mode);
        fetchAlgoLabModels();
      } else {
        alert(data.message || "모드 변경에 실패했습니다.");
        setTradeMode((prev) => ({ ...prev, loading: false }));
      }
    } catch (err) {
      alert("모드 변경 중 통신 오류가 발생했습니다: " + err.message);
      setTradeMode((prev) => ({ ...prev, loading: false }));
    }
  };

  // 11) 가상거래(Paper Trading) 전용 초기화 상태 및 핸들러
  const [paperResetLoading, setPaperResetLoading] = useState(false);

  const handleResetPaperTrades = async () => {
    const confirmMsg =
      "⚠️ [가상거래 초기화]\n가상거래 체결 이력(paper_trades)과 가상 포지션을 모두 삭제하고,\n알고리즘 검증소 모델(100만 원)을 초기화하여 처음부터 다시 거래를 시작하시겠습니까?\n\n* 실제 계좌의 거래 내역과 잔고에는 일절 영향을 주지 않습니다.";
    if (!window.confirm(confirmMsg)) return;

    setPaperResetLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/paper-trades/reset`, { method: "POST" });
      const data = await resp.json();
      if (resp.ok && data.success) {
        showModal("가상거래 초기화 완료", data.message, "success");
        await fetchOverviewAndBots(false, "paper");
        await fetchTrades(selectedBotId, "paper");
        await fetchStatistics("paper");
        await fetchAlgoLabModels();
        await fetchAlgoLabTrades(selectedAlgoModelId);
      } else {
        showModal("초기화 실패", data.message || "오류가 발생했습니다.", "danger");
      }
    } catch (err) {
      showModal("오류", `초기화 요청 중 오류: ${err.message}`, "danger");
    } finally {
      setPaperResetLoading(false);
    }
  };

  // 12) 10대 알고리즘 상시 가상 경쟁(Arena) 상태
  const [algoModels, setAlgoModels] = useState([]);
  const [algoTrades, setAlgoTrades] = useState([]);
  const [selectedAlgoModelId, setSelectedAlgoModelId] = useState("all");
  const [algoLabLoading, setAlgoLabLoading] = useState(false);
  const [algoLabCycleRunning, setAlgoLabCycleRunning] = useState(false);
  const [algoLabLastUpdated, setAlgoLabLastUpdated] = useState("");
  const [arenaStatusInfo, setArenaStatusInfo] = useState({ last_cycle_at: "", last_cycle_summary: "" });

  // 13) 설정 화면: 실전 담당 봇(1~3개) 선택 및 동적 투자금 배분 상태
  const [selectedLiveBotIds, setSelectedLiveBotIds] = useState(["bot_01", "bot_03", "bot_05"]);
  const [savedLiveBotIds, setSavedLiveBotIds] = useState(["bot_01", "bot_03", "bot_05"]);
  const [isLiveConfigDirty, setIsLiveConfigDirty] = useState(false);
  const [liveAllocRatios, setLiveAllocRatios] = useState({ bot_01: 40, bot_03: 40, bot_05: 20 });
  const [savingLiveBots, setSavingLiveBots] = useState(false);
  const [statsModeTab, setStatsModeTab] = useState("live"); // 'live' | 'paper'
  // 통계 메뉴 최하단 실제 거래내역 페이징 상태 (한 페이지 50건 고정, 실거래 전용)
  const [statsTrades, setStatsTrades] = useState([]);
  const [statsTradePage, setStatsTradePage] = useState(1);
  const [statsTradeLimit] = useState(50);
  const [statsTradeTotal, setStatsTradeTotal] = useState(0);
  const [statsTradeTotalPages, setStatsTradeTotalPages] = useState(1);
  const [statsTradeFilterBot, setStatsTradeFilterBot] = useState("all");
  const [statsTradeLoading, setStatsTradeLoading] = useState(false);

  const fetchAlgoLabModels = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/arena/leaderboard`);
      if (!resp.ok) return;
      const data = await resp.json();
      const list = Array.isArray(data.leaderboard) ? data.leaderboard : Array.isArray(data.models) ? data.models : [];
      setAlgoModels(list);
      setAlgoLabLastUpdated(data.updated_at || "");
      if (data.status) {
        setArenaStatusInfo(data.status);
      }
    } catch {}
  }, []);

  const fetchAlgoLabTrades = useCallback(async (modelId = null) => {
    try {
      const targetId = modelId !== undefined && modelId !== null ? modelId : selectedAlgoModelId;
      const url =
        targetId && targetId !== "all"
          ? `${API_BASE}/api/arena/trades?bot_id=${encodeURIComponent(targetId)}&limit=80`
          : `${API_BASE}/api/arena/trades?limit=80`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.success && Array.isArray(data.trades)) {
        setAlgoTrades(data.trades);
      }
    } catch {}
  }, [selectedAlgoModelId]);

  const handleResetAlgoLab = async () => {
    if (!window.confirm("가상거래 전용 원장(paper_trades)과 10대 알고리즘 가상 경쟁을 초기화하시겠습니까?\n(각 봇의 초기 투자자금이 100만 원으로 재설정되고 모든 가상 거래 내역이 삭제된 후 처음부터 다시 경쟁합니다)")) {
      return;
    }
    setAlgoLabLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/arena/reset`, { method: "POST" });
      const data = await resp.json();
      if (resp.ok && data.success) {
        await fetchAlgoLabModels();
        await fetchAlgoLabTrades(selectedAlgoModelId);
        showModal("가상거래 경쟁 초기화 완료", data.message, "success");
      } else {
        alert(data.message || "초기화에 실패했습니다.");
      }
    } catch (err) {
      alert("초기화 중 오류: " + err.message);
    } finally {
      setAlgoLabLoading(false);
    }
  };

  const handleRunAlgoLabCycle = async () => {
    setAlgoLabCycleRunning(true);
    try {
      const resp = await fetch(`${API_BASE}/api/arena/run-cycle`, { method: "POST" });
      const data = await resp.json();
      if (resp.ok && data.success) {
        await fetchAlgoLabModels();
        await fetchAlgoLabTrades(selectedAlgoModelId);
        showModal("가상 시뮬레이션 완료", "10대 알고리즘 순수 시뮬레이션 1사이클이 즉시 실행되었습니다.", "success");
      }
    } catch (err) {
      console.warn("Run cycle error:", err);
    } finally {
      setAlgoLabCycleRunning(false);
    }
  };

  // 실전 담당 봇 선택 토글 (최소 1개 ~ 최대 3개 제한 및 비율 자동 재배분)
  const handleToggleLiveBotSelection = (botId) => {
    setSelectedLiveBotIds((prev) => {
      const validBotList = (algoModels.length > 0 ? algoModels : bots).map((b) => b.bot_id);
      const sanitized = validBotList.length > 0 ? prev.filter((id) => validBotList.includes(id)) : [...prev];

      const isAlready = sanitized.includes(botId);
      let next;
      if (isAlready) {
        if (sanitized.length <= 1) {
          showModal("실전 봇 선택 제한", "실제 거래 담당 봇은 최소 1개 이상 선택해야 합니다.", "warning");
          return sanitized;
        }
        next = sanitized.filter((id) => id !== botId);
      } else {
        if (sanitized.length >= 3) {
          showModal(
            "실전 봇 선택 제한 (최대 3개)",
            "실제 거래 담당 봇은 최대 3개까지만 선택할 수 있습니다.\n기존에 선택된 봇 하나를 클릭하여 해제한 뒤 새로운 봇을 선택해주세요.",
            "warning"
          );
          return sanitized;
        }
        next = [...sanitized, botId];
      }

      // 봇 구성이 변경되었으므로 비율을 자동 재배분(합계 100%)하고 dirty 플래그를 세웁니다.
      const count = next.length;
      const base = Math.floor(100 / count);
      const rem = 100 - base * count;
      const nextRatios = {};
      next.forEach((id, idx) => {
        nextRatios[id] = idx === 0 ? base + rem : base;
      });
      setLiveAllocRatios(nextRatios);
      setIsLiveConfigDirty(true);
      return next;
    });
  };

  // 실전 봇 투자금 비율 실시간 연동 (어느 한쪽을 수정하면 나머지가 자동 조정되어 항상 정확히 100% 유지)
  const handleLiveRatioChange = (changedBotId, newRawVal) => {
    const val = Math.max(0, Math.min(100, Math.round(Number(newRawVal) || 0)));
    setIsLiveConfigDirty(true);

    setLiveAllocRatios((prev) => {
      const ids = selectedLiveBotIds;
      if (ids.length <= 1) {
        return { [changedBotId]: 100 };
      }
      if (ids.length === 2) {
        const otherId = ids.find((id) => id !== changedBotId);
        return {
          [changedBotId]: val,
          [otherId]: 100 - val,
        };
      }
      if (ids.length === 3) {
        const others = ids.filter((id) => id !== changedBotId);
        const [botB, botC] = others;
        const rem = 100 - val;
        const oldB = Number(prev[botB] ?? 0);
        const oldC = Number(prev[botC] ?? 0);
        const oldSum = oldB + oldC;

        let newB, newC;
        if (oldSum > 0) {
          newB = Math.round(rem * (oldB / oldSum));
          newC = rem - newB;
          if (newB < 0) {
            newB = 0;
            newC = rem;
          } else if (newC < 0) {
            newC = 0;
            newB = rem;
          }
        } else {
          newB = Math.floor(rem / 2);
          newC = rem - newB;
        }

        return {
          ...prev,
          [changedBotId]: val,
          [botB]: newB,
          [botC]: newC,
        };
      }
      return { ...prev, [changedBotId]: val };
    });
  };

  // 선택된 실전 봇 균등 배분 (100% N등분)
  const handleDistributeEvenly = () => {
    const count = selectedLiveBotIds.length;
    if (count === 0) return;
    const base = Math.floor(100 / count);
    const rem = 100 - base * count;
    const nextRatios = {};
    selectedLiveBotIds.forEach((id, idx) => {
      nextRatios[id] = idx === 0 ? base + rem : base;
    });
    setLiveAllocRatios(nextRatios);
    setIsLiveConfigDirty(true);
  };

  // 실전 봇 선택 및 동적 투자금 배분 저장 (PUT /api/settings/live-bots)
  const handleSaveLiveBotsAllocation = async (e) => {
    if (e) e.preventDefault();
    if (selectedLiveBotIds.length < 1 || selectedLiveBotIds.length > 3) {
      showModal("설정 오류", "실제 거래 담당 봇은 1개 ~ 3개 사이로 선택해야 합니다.", "warning");
      return;
    }
    const ratioSum = selectedLiveBotIds.reduce((acc, id) => acc + Number(liveAllocRatios[id] || 0), 0);
    if (Math.abs(ratioSum - 100) > 0.1) {
      showModal("비율 설정 오류", `선택된 실전 봇들의 투자 비율 합계는 정확히 100%여야 합니다. (현재 ${ratioSum.toFixed(1)}%)`, "danger");
      return;
    }
    // 요구사항: 총 실전 운영 원금은 수동 입력이 아닌 실제 upbit 실계좌 잔고의 90% 자동 산출
    const liveAsset = Number(upbitAccount?.total_asset_krw ?? upbitAccount?.krw_total ?? upbitAccount?.krw_balance ?? 0);
    const dynamicCapital = Math.floor(liveAsset * 0.9);
    const fallbackCapital = Math.floor(parseNumericInput(totalCapitalInput) || 0);
    const numericCapital = dynamicCapital > 0 ? dynamicCapital : fallbackCapital;

    if (!(numericCapital > 0)) {
      showModal("원금 설정 오류", "업비트 실계좌 잔고를 확인할 수 없거나 잔고가 0원 이하입니다.", "danger");
      return;
    }

    setSavingLiveBots(true);
    try {
      const payload = {
        total_capital: numericCapital,
        selected_bots: selectedLiveBotIds.map((id) => ({
          bot_id: id,
          allocation_ratio: Number(((liveAllocRatios[id] || 0) / 100).toFixed(4)),
        })),
      };
      const resp = await fetch(`${API_BASE}/api/settings/live-bots`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setSavedLiveBotIds([...selectedLiveBotIds]);
        setIsLiveConfigDirty(false);
        await fetchOverviewAndBots(false, "live");
        await fetchAlgoLabModels();
        showModal(
          "실전 봇 및 투자금 설정 저장 완료",
          `${data.message}\n총 운용 원금: ${numericCapital.toLocaleString("ko-KR")}원 (실계좌 잔고 90% 자동 적용)\n선택된 실전 봇: ${data.selected_bots?.map((b) => b.nickname || b.bot_id).join(", ")}`,
          "success"
        );
      } else {
        showModal("저장 실패", data.detail || data.message || "요청 처리에 실패했습니다.", "danger");
      }
    } catch (err) {
      showModal("통신 오류", `설정 저장 중 오류: ${err.message}`, "danger");
    } finally {
      setSavingLiveBots(false);
    }
  };

  const fetchAiBriefing = async (silent = false) => {
    if (silent && isAiBusyRef.current) return;
    try {
      const resp = await fetch(`${API_BASE}/api/ai/briefing`);
      if (resp.ok) {
        const data = await resp.json();
        setAiBriefing(data);
        if (data.quota) {
          setGeminiQuota(data.quota);
        }
      }
    } catch (err) {
      if (!silent) {
        console.error("Failed to fetch AI briefing:", err);
      }
    }
  };

  const fetchNewsAiBriefing = async (silent = false) => {
    if (silent && isNewsAiBusyRef.current) return;
    try {
      const resp = await fetch(`${API_BASE}/api/ai/news-briefing`);
      if (resp.ok) {
        const data = await resp.json();
        setNewsAiBriefing(data);
        if (data.quota) {
          setGeminiQuota(data.quota);
        }
        if (data.latest?.id) {
          if (lastBriefingIdRef.current !== null && Number(data.latest.id) > Number(lastBriefingIdRef.current)) {
            showWebPushNotification("AI 뉴스 분석 완료", "ai 분석이 완료되었습니다", {
              tag: `news-auto-${data.latest.id}`,
            });
          }
          lastBriefingIdRef.current = Number(data.latest.id);
        }
      }
    } catch (err) {
      if (!silent) {
        console.warn("Failed to fetch news AI briefing:", err);
      }
    }
  };

  const fetchWeeklyBotSelection = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/ai/weekly-bot-selection`);
      if (resp.ok) {
        const data = await resp.json();
        setWeeklyBotSelection(data);
      }
    } catch (err) {
      console.warn("Failed to fetch weekly bot selection:", err);
    }
  };

  const triggerWeeklyBotSelection = async () => {
    setWeeklyBotLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/ai/weekly-bot-selection/run`, { method: "POST" });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setWeeklyBotSelection(data);
        await fetchOverviewAndBots(true);
        showModal(
          "AI 주간 봇 자동 편성 완료",
          `매주 일요일 09:00 기점 최적 봇이 실전 매매 담당으로 자동 세팅되었습니다.\n\n` +
          `🥇 1위: ${data.selected_bots?.[0]?.nickname || ""} (${(Number(data.selected_bots?.[0]?.allocation_ratio || 0.34) * 100).toFixed(0)}%)\n` +
          `🥈 2위: ${data.selected_bots?.[1]?.nickname || ""} (${(Number(data.selected_bots?.[1]?.allocation_ratio || 0.33) * 100).toFixed(0)}%)\n` +
          `🥉 3위: ${data.selected_bots?.[2]?.nickname || ""} (${(Number(data.selected_bots?.[2]?.allocation_ratio || 0.33) * 100).toFixed(0)}%)\n\n` +
          `전략: ${data.portfolio_strategy || "방어형 포트폴리오"}`,
          "success"
        );
      } else {
        showModal("AI 주간 봇 평가 실패", data.error || data.message || "평가 실행 중 오류가 발생했습니다.", "danger");
      }
    } catch (err) {
      showModal("통신 오류", `AI 주간 봇 평가 실행 실패: ${err.message}`, "danger");
    } finally {
      setWeeklyBotLoading(false);
    }
  };

  const triggerAiAnalysis = async () => {
    if (geminiQuota && Number(geminiQuota.remaining_calls) <= 0) {
      showModal(
        "무료 API 호출 한도 안내",
        "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
        "warning"
      );
      return;
    }

    setIsAiBriefingExpanded(true);
    setAiLoading(true);
    isAiBusyRef.current = true;
    setAiError("");
    setStreamingText("");
    setStreamingMeta(null);
    typewriterQueueRef.current = "";
    isStreamDoneRef.current = false;

    if (activeStreamAbortControllerRef.current) {
      activeStreamAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    activeStreamAbortControllerRef.current = controller;

    try {
      const resp = await fetch(`${API_BASE}/api/ai/stream-analyze`, {
        method: "POST",
        signal: controller.signal,
      });

      if (!resp.ok) {
        let errMsg = `분석 요청 실패 (HTTP ${resp.status})`;
        let isQuotaExceeded = resp.status === 429;
        try {
          const errData = await resp.json();
          errMsg = errData.message || errMsg;
          if (errData.quota) {
            setGeminiQuota(errData.quota);
          }
          if (errData.error === "DAILY_QUOTA_EXCEEDED" || resp.status === 429) {
            isQuotaExceeded = true;
          } else if (errData.error === "NO_API_KEY") {
            setShowAiKeyConfig(true);
          }
        } catch {}

        setAiLoading(false);
        isAiBusyRef.current = false;

        if (isQuotaExceeded) {
          showModal(
            "무료 API 호출 한도 안내",
            "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
            "warning"
          );
          return;
        }

        setAiError(errMsg);
        return;
      }

      setIsStreaming(true);
      setAiLoading(false);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let capturedMeta = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const blocks = sseBuffer.split("\n\n");
        sseBuffer = blocks.pop() || "";

        for (const block of blocks) {
          const trimmed = block.trim();
          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const data = JSON.parse(jsonStr);
              if (data.type === "meta") {
                capturedMeta = data;
                setStreamingMeta(data);
                if (data.quota) {
                  setGeminiQuota(data.quota);
                  setGeminiQuotaNotice(
                    `금일 자동 분석 예약(${data.quota.auto_reserved_count}건) 제외 남은 무료 API 호출 건수: ${data.quota.remaining_calls}건 (일일 수동 한도 ${data.quota.manual_limit}건 중 ${data.quota.manual_used}건 사용)`
                  );
                }
              } else if (data.type === "chunk" && data.text) {
                typewriterQueueRef.current += data.text;
              } else if (data.type === "done") {
                isStreamDoneRef.current = true;
                isAiBusyRef.current = false;
                if (data.quota) {
                  setGeminiQuota(data.quota);
                  setGeminiQuotaNotice(
                    `금일 자동 분석 예약(${data.quota.auto_reserved_count}건) 제외 남은 무료 API 호출 건수: ${data.quota.remaining_calls}건 (일일 수동 한도 ${data.quota.manual_limit}건 중 ${data.quota.manual_used}건 사용)`
                  );
                }
                setAiBriefing((prev) => ({
                  ...prev,
                  last_trigger_type: data.trigger_type || "MANUAL",
                  quota: data.quota || prev.quota,
                  regime_filter: data.regime_filter || capturedMeta?.regime_filter || prev.regime_filter,
                  latest: {
                    id: data.id,
                    provider: "gemini",
                    model: data.model,
                    btc_price: capturedMeta?.btc_price,
                    btc_daily_20ma: capturedMeta?.btc_daily_20ma,
                    btc_4h_60ma: capturedMeta?.btc_4h_60ma,
                    regime_status: capturedMeta?.regime_status,
                    briefing_text: data.full_text,
                    created_at: data.created_at,
                  },
                }));
              } else if (data.type === "error") {
                setAiError(data.message || "스트리밍 중 오류가 발생했습니다.");
                isStreamDoneRef.current = true;
                isAiBusyRef.current = false;
              }
            } catch {}
          }
        }
      }

      isStreamDoneRef.current = true;
      isAiBusyRef.current = false;
    } catch (err) {
      setAiError(`서버 연결 오류: ${err.message}`);
      setIsStreaming(false);
      setAiLoading(false);
      isAiBusyRef.current = false;
    }
  };

  const handleSaveAiKey = async () => {
    if (!aiKeyInput.trim()) {
      setAiError("Gemini API 키를 입력해주세요.");
      return;
    }
    setAiLoading(true);
    setAiError("");
    try {
      const resp = await fetch(`${API_BASE}/api/ai/save-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gemini_api_key: aiKeyInput.trim() }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setAiBriefing((prev) => ({
          ...prev,
          has_key: data.has_key,
          masked_key: data.masked_key,
        }));
        if (data.quota) {
          setGeminiQuota(data.quota);
        }
        setAiKeyInput("");
        setShowAiKeyConfig(false);
        showModal(
          "Gemini API 키 저장 완료",
          "Gemini API 키가 config/upbit_config.json에 성공적으로 저장되었습니다. 이제 [AI 시황 분석 요청]을 실행하실 수 있습니다.",
          "success"
        );
      } else {
        setAiError("API 키 저장에 실패했습니다.");
      }
    } catch (err) {
      setAiError(`저장 중 오류: ${err.message}`);
    } finally {
      setAiLoading(false);
    }
  };

  // 입장 코드 검증 (기본: stock, 날짜가 바뀌면 재인증 요구)
  const handleVerifyEntryCode = async (e) => {
    e.preventDefault();
    setGateError("");
    const trimmed = entryCodeInput.trim();
    // 한글 자판 상태에서 stock을 입력한 경우(ㄴ새차) 자동 영문 변환
    const normalized = trimmed === "ㄴ새차" ? "stock" : trimmed;
    const today = getTodayKSTDateString();

    try {
      const resp = await fetch(`${API_BASE}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalized }),
      });
      if (resp.ok) {
        sessionStorage.setItem("autoCoinTrade_auth", "true");
        localStorage.setItem("autoCoinTrade_auth", "true");
        sessionStorage.setItem("autoCoinTrade_auth_date", today);
        localStorage.setItem("autoCoinTrade_auth_date", today);
        setEntryCodeInput("");
        setAuthenticated(true);
      } else {
        const err = await resp.json().catch(() => ({}));
        setGateError(err.message || "입장 코드가 일치하지 않습니다.");
      }
    } catch {
      // 서버 연결 불가 시 기본 코드 'stock' 폴백
      if (normalized.toLowerCase() === "stock") {
        sessionStorage.setItem("autoCoinTrade_auth", "true");
        localStorage.setItem("autoCoinTrade_auth", "true");
        sessionStorage.setItem("autoCoinTrade_auth_date", today);
        localStorage.setItem("autoCoinTrade_auth_date", today);
        setEntryCodeInput("");
        setAuthenticated(true);
      } else {
        setGateError("서버 연결 실패 또는 입장 코드가 일치하지 않습니다.");
      }
    }
  };

  // 날짜 변경(자정 경과) 실시간 감지: 하루가 지나 날짜가 바뀌면 즉시 인증 화면으로 전환
  // 브라우저 웹 알림 및 서비스 워커 초기화
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotificationPermission(Notification.permission);
      if (Notification.permission === "granted") {
        registerAndSubscribePush(false);
      }
    }
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const handleSwMessage = (event) => {
        if (event.data?.type === "NAVIGATE_MENU" && event.data.menu) {
          setActiveMenu(event.data.menu);
        }
      };
      navigator.serviceWorker.addEventListener("message", handleSwMessage);
      return () => {
        navigator.serviceWorker.removeEventListener("message", handleSwMessage);
      };
    }
  }, [registerAndSubscribePush]);

  useEffect(() => {
    if (!authenticated) return;
    const checkDateExpiration = () => {
      if (!isDailyGateAuthValid()) {
        setAuthenticated(false);
        setEntryCodeInput("");
        setGateError("날짜가 변경되어 보안을 위해 인증이 만료되었습니다. 입장 코드를 다시 입력해주세요.");
      }
    };
    const dateTimer = setInterval(checkDateExpiration, 5000);
    const handleVisibilityOrFocus = () => checkDateExpiration();
    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    return () => {
      clearInterval(dateTimer);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, [authenticated]);

  // 업비트 통신 상태 주기적 조회
  const fetchUpbitStatus = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/upbit/status`);
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.status) {
          setUpbitStatus(data);
        } else {
          setUpbitStatus({
            status: "red",
            label: "통신불가",
            latency_ms: 0,
            reason: "업비트 통신 상태 응답 형식이 올바르지 않습니다.",
            checked_at: new Date().toLocaleTimeString(),
          });
        }
      } else {
        setUpbitStatus({
          status: "red",
          label: "통신불가",
          latency_ms: 0,
          reason: `업비트/백엔드 API 통신 오류 (HTTP ${resp.status})`,
          checked_at: new Date().toLocaleTimeString(),
        });
      }
    } catch (err) {
      setUpbitStatus({
        status: "red",
        label: "통신불가",
        latency_ms: 0,
        reason: `백엔드 API 서버(Port 8001) 연결 불가: ${err.message}`,
        checked_at: new Date().toLocaleTimeString(),
      });
    }
  };

  // 시스템 개요 및 봇 정보 조회
  const fetchOverviewAndBots = async (triggerZeroModalOnTrades = false, targetMode = null) => {
    try {
      const mode = targetMode || tradeMode.mode;
      const resp = await fetch(`${API_BASE}/api/system/overview?mode=${encodeURIComponent(mode)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      const botList = data.bots || [];
      setBots(botList);
      setTotalCapitalInput(
        data.total_capital !== null && data.total_capital !== undefined && data.total_capital !== 0
          ? data.total_capital
          : ""
      );

      const newRatios = {};
      const newEditForms = {};
      const liveIds = [];
      const liveRats = {};
      botList.forEach((b) => {
        newRatios[b.bot_id] = b.allocation_ratio ? b.allocation_ratio : "";
        newEditForms[b.bot_id] = {
          nickname: b.nickname || "",
          min_volume_krw: b.min_volume_krw ? b.min_volume_krw : "",
          stop_loss_pct: b.stop_loss_pct ? b.stop_loss_pct : "",
          take_profit_pct: b.take_profit_pct ? b.take_profit_pct : "",
          config: b.config || {},
        };
        if (Number(b.is_selected_for_live) === 1) {
          liveIds.push(b.bot_id);
          liveRats[b.bot_id] = Number(b.allocation_ratio || 0);
        }
      });
      setRatioInputs(newRatios);
      setBotEditForms(newEditForms);
      if (liveIds.length > 0) {
        setSelectedLiveBotIds(liveIds);
        setSavedLiveBotIds(liveIds);
        setLiveAllocRatios(liveRats);
        setIsLiveConfigDirty(false);
      } else if (botList.length > 0) {
        const fallbackIds = botList.slice(0, 3).map((b) => b.bot_id);
        setSelectedLiveBotIds(fallbackIds);
        setSavedLiveBotIds(fallbackIds);
        const fbRats = {};
        fallbackIds.forEach((id, i) => { fbRats[id] = i === 0 ? 34 : 33; });
        setLiveAllocRatios(fbRats);
        setIsLiveConfigDirty(false);
      }

      // 요구사항 21: 설정된 잔고가 0 이하로 떨어져 모든 봇이 거래 중지된 경우 거래현황 진입 시 Modal Popup 표시
      if (data.zero_balance_halted && (triggerZeroModalOnTrades || !zeroBalanceAlerted)) {
        setZeroBalanceAlerted(true);
        showModal(
          "잔고 0원 이하 도달 - 전체 봇 자동 거래 중지",
          data.zero_balance_reason ||
            "설정된 잔고가 0원 이하로 떨어져 모든 봇이 자동으로 거래 중지되었습니다. 설정 메뉴에서 원금 및 자금 분배 비율을 재설정해주세요.",
          "danger"
        );
      }
    } catch (err) {
      console.error("Failed to fetch overview:", err);
    }
  };

  const fetchTrades = async (botId, targetMode = null) => {
    try {
      const targetBot = botId || selectedBotId;
      const mode = targetMode || tradeMode.mode;
      const resp = await fetch(`${API_BASE}/api/trades?bot_id=${encodeURIComponent(targetBot)}&mode=${encodeURIComponent(mode)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      setTrades(data.trades || []);
      if (data.zero_balance_halted && activeMenu === "trades" && !zeroBalanceAlerted) {
        setZeroBalanceAlerted(true);
        showModal(
          "잔고 0원 이하 도달 - 전체 봇 자동 거래 중지",
          data.zero_balance_reason ||
            "설정된 잔고가 0원 이하로 떨어져 모든 봇이 거래 중지 상태입니다.",
          "danger"
        );
      }
    } catch (err) {
      console.error("Failed to fetch trades:", err);
    }
  };

  const fetchStatistics = async (targetMode = null) => {
    try {
      const mode = targetMode || tradeMode.mode;
      const resp = await fetch(`${API_BASE}/api/statistics?mode=${encodeURIComponent(mode)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      setStats(data);
    } catch (err) {
      console.error("Failed to fetch statistics:", err);
    }
  };

  // 통계 메뉴 최하단 거래내역 조회 (페이지당 50건, 실거래/가상거래 모드 연동)
  const fetchStatsTrades = useCallback(
    async (page = 1, botId = null, targetMode = null) => {
      setStatsTradeLoading(true);
      try {
        const targetBot = botId !== null ? botId : statsTradeFilterBot;
        const currentMode = targetMode !== null ? targetMode : statsModeTab;
        const params = new URLSearchParams();
        params.append("page", String(page));
        params.append("limit", "50");
        params.append("mode", currentMode); // 통계 상단 선택 탭(live / paper)과 자동 연동
        if (targetBot && targetBot !== "all") {
          params.append("bot_id", targetBot);
        }
        const resp = await fetch(`${API_BASE}/api/trades?${params.toString()}`);
        if (resp.ok) {
          const data = await resp.json();
          setStatsTrades(Array.isArray(data.trades) ? data.trades : []);
          setStatsTradeTotal(data.total || 0);
          setStatsTradeTotalPages(data.total_pages || 1);
          setStatsTradePage(data.page || page);
        }
      } catch (err) {
        console.error("Failed to fetch stats trades:", err);
      } finally {
        setStatsTradeLoading(false);
      }
    },
    [statsTradeFilterBot, statsModeTab]
  );

  const fetchUpbitAccount = async () => {
    setUpbitAccount((prev) => ({ ...prev, loading: true }));
    try {
      const resp = await fetch(`${API_BASE}/api/upbit/account`);
      if (resp.ok) {
        const data = await resp.json();
        const krwTotal = data.krw_total ?? data.krw_balance ?? null;
        const evalKrw = data.total_eval_krw ?? 0;
        const computedTotalAsset =
          data.total_asset_krw ??
          (krwTotal !== null ? Math.floor(Number(krwTotal) + Number(evalKrw)) : null);
        setUpbitAccount({
          loading: false,
          success: Boolean(data.success),
          krw_balance: data.krw_balance ?? null,
          orderable_krw: data.orderable_krw ?? data.krw_balance ?? null,
          total_buy_krw: data.total_buy_krw ?? null,
          total_eval_krw: data.total_eval_krw ?? null,
          total_asset_krw: computedTotalAsset,
          eval_profit_krw: data.eval_profit_krw ?? null,
          eval_profit_pct: data.eval_profit_pct ?? null,
          krw_locked: data.krw_locked ?? null,
          krw_total: krwTotal,
          message: data.message || "",
          checked_at: data.checked_at || "",
        });
      } else {
        setUpbitAccount({
          loading: false,
          success: false,
          krw_balance: null,
          orderable_krw: null,
          total_buy_krw: null,
          total_eval_krw: null,
          total_asset_krw: null,
          eval_profit_krw: null,
          eval_profit_pct: null,
          krw_locked: null,
          krw_total: null,
          message: `업비트 계좌 잔고 조회 실패 (HTTP ${resp.status})`,
          checked_at: "",
        });
      }
    } catch (err) {
      setUpbitAccount({
        loading: false,
        success: false,
        krw_balance: null,
        orderable_krw: null,
        total_buy_krw: null,
        total_eval_krw: null,
        total_asset_krw: null,
        eval_profit_krw: null,
        eval_profit_pct: null,
        krw_locked: null,
        krw_total: null,
        message: `백엔드 서버 연결 실패: ${err.message}`,
        checked_at: "",
      });
    }
  };

  const refreshBotsStatusOnly = async (targetMode = null) => {
    try {
      const mode = targetMode || tradeMode.mode;
      const resp = await fetch(`${API_BASE}/api/bots?mode=${encodeURIComponent(mode)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (Array.isArray(data.bots)) {
        setBots(data.bots);
      }
    } catch {}
  };

  useEffect(() => {
    if (!authenticated) return;
    fetchUpbitStatus();
    fetchUpbitAccount();
    fetchOverviewAndBots(true);
    fetchTrades(selectedBotId);
    fetchStatistics();
    fetchStatsTrades(1);
    fetchAiBriefing();
    fetchNewsAiBriefing();
    fetchWeeklyBotSelection();
    fetchTradeMode();
    fetchAlgoLabModels();
    fetchEntryCode();

    const timer = setInterval(() => {
      fetchUpbitStatus();
      fetchUpbitAccount();
      refreshBotsStatusOnly();
      fetchTrades(selectedBotId);
      fetchTradeMode();
      fetchAiBriefing(true);
      fetchNewsAiBriefing(true);
    }, 6000);
    return () => clearInterval(timer);
  }, [authenticated, selectedBotId, fetchTradeMode, fetchAlgoLabModels, fetchEntryCode]);

  // 가상거래 경쟁(Arena) 활성화 시 5초 주기 실시간 리더보드 및 체결 일지 자동 갱신
  useEffect(() => {
    if (!authenticated || (activeMenu !== "arena" && activeMenu !== "algo-lab")) return;
    fetchAlgoLabModels();
    fetchAlgoLabTrades(selectedAlgoModelId);

    const timer = setInterval(() => {
      fetchAlgoLabModels();
      fetchAlgoLabTrades(selectedAlgoModelId);
    }, 5000);
    return () => clearInterval(timer);
  }, [authenticated, activeMenu, selectedAlgoModelId, fetchAlgoLabModels, fetchAlgoLabTrades]);

  useEffect(() => {
    sessionStorage.setItem("autoCoinTrade_menu", activeMenu);
    localStorage.setItem("autoCoinTrade_menu", activeMenu);
    if (activeMenu === "settings") {
      fetchEntryCode();
    }
  }, [activeMenu, fetchEntryCode]);

  useEffect(() => {
    sessionStorage.setItem("autoCoinTrade_bot", selectedBotId);
    localStorage.setItem("autoCoinTrade_bot", selectedBotId);
  }, [selectedBotId]);

  useEffect(() => {
    sessionStorage.setItem("autoCoinTrade_statsTab", statsPeriodTab);
    localStorage.setItem("autoCoinTrade_statsTab", statsPeriodTab);
  }, [statsPeriodTab]);

  // 뉴스 목록 조회 (한 페이지 50건, 날짜/키워드 검색)
  const fetchNews = useCallback(
    async (page = 1, options = {}) => {
      setNewsLoading(true);
      try {
        const kw = options.keyword !== undefined ? options.keyword : newsKeyword;
        const sDate = options.startDate !== undefined ? options.startDate : newsStartDate;
        const eDate = options.endDate !== undefined ? options.endDate : newsEndDate;

        const params = new URLSearchParams();
        params.append("page", String(page));
        params.append("limit", "50");
        if (kw && kw.trim()) params.append("keyword", kw.trim());
        if (sDate) params.append("start_date", sDate);
        if (eDate) params.append("end_date", eDate);

        const resp = await fetch(`${API_BASE}/api/news?${params.toString()}`);
        if (resp.ok) {
          const data = await resp.json();
          setNewsList(data.items || []);
          setNewsTotal(data.total || 0);
          setNewsPage(data.page || 1);
          setNewsTotalPages(data.total_pages || 1);
        }
      } catch (err) {
        console.warn("Failed to fetch news:", err);
      } finally {
        setNewsLoading(false);
      }
    },
    [newsKeyword, newsStartDate, newsEndDate]
  );

  const triggerNewsAiAnalysis = async () => {
    if (geminiQuota && Number(geminiQuota.remaining_calls) <= 0) {
      showModal(
        "무료 API 호출 한도 안내",
        "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
        "warning"
      );
      return;
    }

    setIsNewsAiExpanded(true);
    setNewsAiLoading(true);
    isNewsAiBusyRef.current = true;
    setNewsStreamingText("");
    setNewsStreamingMeta(null);
    newsTypewriterQueueRef.current = "";
    isNewsStreamDoneRef.current = false;

    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      registerAndSubscribePush(true);
    }

    if (activeNewsStreamAbortControllerRef.current) {
      activeNewsStreamAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    activeNewsStreamAbortControllerRef.current = controller;

    try {
      const resp = await fetch(`${API_BASE}/api/ai/stream-news-analyze`, {
        method: "POST",
        signal: controller.signal,
      });

      if (!resp.ok) {
        let errMsg = `AI 분석 요청 실패 (HTTP ${resp.status})`;
        let isQuotaExceeded = resp.status === 429;
        try {
          const errData = await resp.json();
          errMsg = errData.message || errMsg;
          if (errData.quota) {
            setGeminiQuota(errData.quota);
          }
          if (errData.error === "DAILY_QUOTA_EXCEEDED" || resp.status === 429) {
            isQuotaExceeded = true;
          } else if (errData.error === "NO_API_KEY") {
            setShowAiKeyConfig(true);
          }
        } catch {}

        setNewsAiLoading(false);
        isNewsAiBusyRef.current = false;
        if (isQuotaExceeded) {
          showModal(
            "무료 API 호출 한도 안내",
            "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
            "warning"
          );
          return;
        }
        setNewsStreamingText(`⚠️ ${errMsg}`);
        return;
      }

      setIsNewsStreaming(true);
      setNewsAiLoading(false);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const blocks = sseBuffer.split("\n\n");
        sseBuffer = blocks.pop() || "";

        for (const block of blocks) {
          const trimmed = block.trim();
          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const data = JSON.parse(jsonStr);
              if (data.type === "meta") {
                setNewsStreamingMeta(data);
                if (data.quota) {
                  setGeminiQuota(data.quota);
                  setGeminiQuotaNotice(
                    `금일 자동 분석 예약(${data.quota.auto_reserved_count}건) 제외 남은 무료 API 호출 건수: ${data.quota.remaining_calls}건 (일일 수동 한도 ${data.quota.manual_limit}건 중 ${data.quota.manual_used}건 사용)`
                  );
                }
              } else if (data.type === "chunk" && data.text) {
                newsTypewriterQueueRef.current += data.text;
              } else if (data.type === "done") {
                isNewsStreamDoneRef.current = true;
                isNewsAiBusyRef.current = false;
                if (data.id) {
                  lastBriefingIdRef.current = Number(data.id);
                }
                // 웹푸시 알림 발송: "ai 분석이 완료되었습니다"
                showWebPushNotification("AI 뉴스 분석 완료", "ai 분석이 완료되었습니다", {
                  tag: `news-manual-${data.id || Date.now()}`,
                });
                if (data.quota) {
                  setGeminiQuota(data.quota);
                  setGeminiQuotaNotice(
                    `금일 자동 분석 예약(${data.quota.auto_reserved_count}건) 제외 남은 무료 API 호출 건수: ${data.quota.remaining_calls}건 (일일 수동 한도 ${data.quota.manual_limit}건 중 ${data.quota.manual_used}건 사용)`
                  );
                }
                setNewsAiBriefing((prev) => ({
                  ...prev,
                  last_trigger_type: data.trigger_type || "MANUAL",
                  quota: data.quota || prev.quota,
                  latest: {
                    id: data.id,
                    provider: "gemini",
                    model: data.model,
                    news_count: data.news_count,
                    bullish_count: data.bullish_count,
                    bearish_count: data.bearish_count,
                    neutral_count: data.neutral_count,
                    briefing_text: data.full_text,
                    created_at: data.created_at,
                  },
                }));
              } else if (data.type === "error") {
                setNewsStreamingText((prev) => prev + `\n\n[오류] ${data.message || "스트리밍 중단"}`);
                isNewsStreamDoneRef.current = true;
                isNewsAiBusyRef.current = false;
              }
            } catch {}
          }
        }
      }
      isNewsStreamDoneRef.current = true;
      isNewsAiBusyRef.current = false;
    } catch (err) {
      setNewsStreamingText(`⚠️ 서버 연결 오류: ${err.message}`);
      setIsNewsStreaming(false);
      setNewsAiLoading(false);
      isNewsAiBusyRef.current = false;
    }
  };

  useEffect(() => {
    if (activeMenu === "news") {
      fetchNews(1);
      fetchNewsAiBriefing();
    }
  }, [activeMenu, fetchNews]);

  const handleSearchNews = (e) => {
    if (e) e.preventDefault();
    fetchNews(1);
  };

  const handleResetNewsFilter = () => {
    setNewsKeyword("");
    setNewsStartDate("");
    setNewsEndDate("");
    fetchNews(1, { keyword: "", startDate: "", endDate: "" });
  };

  const handleQuickTagClick = (tag) => {
    const cleanTag = tag.replace(/^#/, "");
    setNewsKeyword(cleanTag);
    fetchNews(1, { keyword: cleanTag });
  };

  const handleRefreshNews = async () => {
    setNewsRefreshing(true);
    setNewsNotice("최신 뉴스를 실시간 수집 및 감성 분석 중입니다...");
    try {
      const resp = await fetch(`${API_BASE}/api/news/refresh`, { method: "POST" });
      if (resp.ok) {
        const data = await resp.json();
        setNewsNotice(`뉴스 수집 완료: 신규 ${data.newly_inserted || 0}건 추가`);
        await fetchNews(1);
      } else {
        setNewsNotice("뉴스 수집 요청 중 오류가 발생했습니다.");
      }
    } catch (err) {
      setNewsNotice(`뉴스 수집 중 오류: ${err.message}`);
    } finally {
      setNewsRefreshing(false);
      setTimeout(() => setNewsNotice(""), 6000);
    }
  };

  // 메뉴 전환 시 처리 (거래현황 진입 시 잔고 0 이하 여부 즉시 체크하여 모달 표기)
  const handleMenuChange = (menuKey) => {
    const targetKey = menuKey === "algo-lab" ? "arena" : menuKey;
    setActiveMenu(targetKey);
    sessionStorage.setItem("autoCoinTrade_menu", targetKey);
    localStorage.setItem("autoCoinTrade_menu", targetKey);
    if (targetKey === "trades") {
      fetchOverviewAndBots(true, "live");
      fetchUpbitAccount();
      fetchTrades(selectedBotId, "live");
    } else if (targetKey === "arena") {
      fetchAlgoLabModels();
      fetchAlgoLabTrades(selectedAlgoModelId);
    } else if (targetKey === "stats") {
      fetchStatistics(statsModeTab);
      fetchStatsTrades(1, statsTradeFilterBot);
    } else if (targetKey === "news") {
      fetchNews(1);
      fetchNewsAiBriefing();
    } else if (targetKey === "settings") {
      fetchOverviewAndBots(false, "live");
      fetchUpbitAccount();
      fetchAlgoLabModels();
    }
  };

  // 요구사항 20: 거래 시작 / 중단 수동 제어 및 정상 동작 확인 Modal Popup 표기
  const handleBotStartStop = async (botId, start) => {
    if (start && isLiveConfigDirty) {
      showModal(
        "설정 저장 필수",
        "실전 거래 담당 봇 구성 또는 투자금 비율이 변경되었습니다.\n설정(⚙️) 메뉴에서 먼저 [실전 거래 담당 봇 및 투자금 설정 저장]을 완료해야 거래를 시작할 수 있습니다.",
        "warning"
      );
      return;
    }
    const endpoint = start ? "start" : "stop";
    try {
      const resp = await fetch(`${API_BASE}/api/bots/${botId}/${endpoint}`, {
        method: "POST",
      });
      const data = await resp.json();
      await fetchOverviewAndBots(false);
      await fetchTrades(botId);

      if (data.success) {
        showModal(
          start ? "거래 시작 완료" : "거래 중지 완료",
          data.message ||
            (start
              ? "선택한 봇의 자동매매 거래가 정상적으로 시작되었습니다."
              : "선택한 봇의 자동매매 거래가 정상적으로 중지되었습니다."),
          start ? "success" : "info"
        );
      } else {
        showModal("거래 상태 변경 실패", data.message || "요청을 처리할 수 없습니다.", "danger");
      }
    } catch (err) {
      showModal("통신 오류", `봇 제어 요청 중 오류가 발생했습니다: ${err.message}`, "danger");
    }
  };

  // 수동 매수 / 보유 지분 분할 매도 테스트 (한 줄 업데이트 및 포지션 격리 확인용)
  const handleManualTradeTest = async (botId, action) => {
    try {
      const resp = await fetch(`${API_BASE}/api/bots/${botId}/manual-trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, market: "KRW-BTC" }),
      });
      const data = await resp.json();
      await fetchOverviewAndBots(false);
      await fetchTrades(botId);
      await fetchStatistics();
      showModal(
        action === "buy" ? "즉시 매수 실행 결과" : "보유 지분 분할 매도 결과",
        data.message,
        data.success ? "success" : "danger"
      );
    } catch (err) {
      showModal("오류", err.message, "danger");
    }
  };

  // 요구사항 22: 자금 분배 비율 저장 (실계좌 잔고 90% 자동 적용)
  const handleSaveAllocation = async (e) => {
    e.preventDefault();
    const liveAsset = Number(upbitAccount?.total_asset_krw ?? upbitAccount?.krw_total ?? upbitAccount?.krw_balance ?? 0);
    const dynamicCapital = Math.floor(liveAsset * 0.9);
    const numericCapital = dynamicCapital > 0 ? dynamicCapital : Math.floor(parseNumericInput(totalCapitalInput));
    const ratioSum = Number(
      Object.values(ratioInputs)
        .reduce((acc, v) => acc + Number(v || 0), 0)
        .toFixed(2)
    );

    if (ratioSum > 100) {
      showModal(
        "자금 분배 설정 오류",
        `봇별 자금 분배 비율의 합계(${ratioSum}%)는 100%를 초과할 수 없습니다.`,
        "danger"
      );
      return;
    }

    const maxAssetLimit = Number(upbitAccount.total_asset_krw ?? upbitAccount.krw_balance ?? 0);
    if (!upbitAccount.success || upbitAccount.total_asset_krw === null) {
      showModal(
        "운용 원금 저장 불가",
        `업비트 실계좌 및 총 보유 자산이 조회되지 않아 전체 운용 원금을 저장할 수 없습니다.\n(${upbitAccount.message || "업비트 실계좌 조회 필요"})`,
        "danger"
      );
      return;
    }

    if (numericCapital > maxAssetLimit) {
      showModal(
        "운용 원금 설정 오류 — 총 보유 자산 한도 초과",
        `입력한 전체 운용 원금(${numericCapital.toLocaleString("ko-KR")}원)이 업비트 총 보유 자산(${maxAssetLimit.toLocaleString(
          "ko-KR"
        )}원)의 한도를 초과합니다.\n전체 운용 원금은 총 보유 자산 이하로만 저장할 수 있습니다.`,
        "danger"
      );
      return;
    }

    const previewPlan = computeAllocationPreview(numericCapital, bots, ratioInputs);
    if (numericCapital > 0 && numericCapital < previewPlan.totalUsed) {
      showModal(
        "운용 원금 설정 오류 — 이미 사용된 투자금 미달",
        `입력한 전체 운용 원금(${numericCapital.toLocaleString("ko-KR")}원)이 현재 이미 매수에 사용된 투자금(${previewPlan.totalUsed.toLocaleString(
          "ko-KR"
        )}원)보다 적습니다.\n최소 ${previewPlan.totalUsed.toLocaleString("ko-KR")}원 이상으로 설정해주세요.`,
        "danger"
      );
      return;
    }

    try {
      const resp = await fetch(`${API_BASE}/api/settings/allocation`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          total_capital: numericCapital,
          ratios: ratioInputs,
        }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data || !data.success) {
        const errMsg =
          data?.detail ||
          data?.message ||
          `운용 원금 설정 저장 중 서버 오류가 발생했습니다 (HTTP ${resp.status}).`;
        showModal("운용 원금 및 자금 분배 저장 오류", errMsg, "danger");
        return;
      }
      setZeroBalanceAlerted(false);
      await fetchOverviewAndBots(true);
      showModal(
        "자금 분배 비율 설정 완료",
        data.zero_balance_halted
          ? data.zero_balance_reason
          : `${data.message}\n총 운용 원금: ${numericCapital.toLocaleString("ko-KR")}원`,
        data.zero_balance_halted ? "danger" : "success"
      );
    } catch (err) {
      showModal(
        "운용 원금 및 자금 분배 저장 오류",
        `백엔드 서버(${API_BASE})와 통신할 수 없어 운용 원금 설정이 저장되지 않았습니다.\n사유: ${err.message}`,
        "danger"
      );
    }
  };

  // 요구사항 15: 봇 수정 및 별명(Nickname) 저장
  const handleSaveBotConfig = async (botId) => {
    const form = botEditForms[botId];
    if (!form) return;
    try {
      const resp = await fetch(`${API_BASE}/api/bots/${botId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await resp.json();
      if (!resp.ok) {
        showModal("봇 설정 저장 실패", data.detail || "입력값을 확인해주세요.", "danger");
        return;
      }
      await fetchOverviewAndBots(false);
      showModal("봇 설정 저장 완료", data.message, "success");
    } catch (err) {
      showModal("오류", err.message, "danger");
    }
  };

  // 요구사항 13: JSON 파일 마이그레이션 (내보내기)
  const handleExportJson = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/settings/export`);
      if (!resp.ok) throw new Error("데이터 내보내기 실패");
      const data = await resp.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `autoCoinTrade_migration_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showModal(
        "데이터 마이그레이션(JSON) 완료",
        "현재 DB의 모든 봇 설정, 거래 내역, 포지션 정보가 JSON 파일로 저장되었습니다.",
        "success"
      );
    } catch (err) {
      showModal("마이그레이션 오류", err.message, "danger");
    }
  };

  // 요구사항 13: JSON 파일 읽어서 DB 복원
  const handleImportJsonFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const resp = await fetch(`${API_BASE}/api/settings/import-json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await resp.json();
      if (!resp.ok) {
        showModal("데이터 복원 실패", data.detail || "유효하지 않은 파일입니다.", "danger");
        return;
      }
      setBotEditForms({});
      await fetchOverviewAndBots(false);
      await fetchTrades(selectedBotId);
      await fetchStatistics();
      showModal("데이터 복원 완료", data.message, "success");
    } catch (err) {
      showModal("JSON 파일 읽기 오류", `파일 복원 중 오류가 발생했습니다: ${err.message}`, "danger");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // 보안 및 입장 코드 변경 저장
  const handleSaveEntryCode = async (e) => {
    if (e) e.preventDefault();
    setEntryCodeMsg(null);
    const trimmed = newEntryCodeInput.trim();
    if (!trimmed) {
      setEntryCodeMsg({ type: "error", text: "새 입장 코드를 입력해주세요." });
      return;
    }
    if (trimmed.length < 2) {
      setEntryCodeMsg({ type: "error", text: "입장 코드는 최소 2자 이상이어야 합니다." });
      return;
    }
    if (newEntryCodeConfirm !== "" && trimmed !== newEntryCodeConfirm.trim()) {
      setEntryCodeMsg({ type: "error", text: "입장 코드 확인 값이 일치하지 않습니다." });
      return;
    }
    setEntryCodeLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/settings/entry-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_code: trimmed }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setEntryCodeSetting(data.entry_code);
        setNewEntryCodeInput(data.entry_code);
        setNewEntryCodeConfirm("");
        setEntryCodeMsg({
          type: "success",
          text: `입장 코드가 [${data.entry_code}]로 성공적으로 변경되었습니다. 다음 접속 시 변경된 코드로 입장하세요.`,
        });
        showModal(
          "입장 코드 변경 완료",
          `입장 코드가 [${data.entry_code}]로 변경되었습니다.\n다음 로그인 시 변경된 코드를 입력해주세요.`,
          "success"
        );
      } else {
        setEntryCodeMsg({ type: "error", text: data.message || "입장 코드 변경에 실패했습니다." });
      }
    } catch (err) {
      setEntryCodeMsg({ type: "error", text: `서버 통신 오류: ${err.message}` });
    } finally {
      setEntryCodeLoading(false);
    }
  };

  const currentBot = useMemo(
    () => bots.find((b) => b.bot_id === selectedBotId) || bots[0] || null,
    [bots, selectedBotId]
  );

  // ------------------------------------------------------------------
  // 초기 설정 마법사 화면 (Step-by-Step Onboarding Setup Wizard)
  // ------------------------------------------------------------------
  if (showSetupWizard) {
    return (
      <div className="wizard-wrapper">
        <div className="wizard-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
            <div>
              <span className="wizard-top-badge">🚀 AUTO COIN TRADE ONBOARDING</span>
              <h1 className="wizard-title">초기 환경 설정 마법사</h1>
              <p className="wizard-desc">
                비개발자도 클릭 몇 번으로 바로 구동할 수 있도록 시스템 환경과 데이터베이스를 자동으로 구성합니다.
              </p>
            </div>
            {setupConfigured && (
              <button
                type="button"
                onClick={() => setShowSetupWizard(false)}
                className="btn btn-outline"
                style={{ padding: "6px 14px", fontSize: "12.5px" }}
              >
                ✕ 대시보드로 돌아가기
              </button>
            )}
          </div>

          {/* Stepper Header */}
          <div className="wizard-stepper">
            {[
              { num: 1, title: "기본 & 보안" },
              { num: 2, title: "데이터베이스(DB)" },
              { num: 3, title: "거래소 & AI 키" },
              { num: 4, title: "설치 및 구동" },
            ].map((step) => {
              const isActive = wizardStep === step.num;
              const isDone = wizardStep > step.num;
              return (
                <button
                  key={step.num}
                  type="button"
                  className={`wizard-step-node ${isActive ? "active" : ""} ${isDone ? "completed" : ""}`}
                  onClick={() => !installState.installing && setWizardStep(step.num)}
                  disabled={installState.installing}
                >
                  <div className="wizard-step-circle">
                    {isDone ? "✔" : step.num}
                  </div>
                  <span className="wizard-step-label">{step.title}</span>
                </button>
              );
            })}
          </div>

          {/* Step 1: 기본 및 보안 설정 */}
          {wizardStep === 1 && (
            <div>
              <div className="wizard-form-group">
                <label className="wizard-label">🔒 웹 대시보드 입장 코드 (비밀번호)</label>
                <input
                  type="text"
                  className="wizard-input"
                  value={wizardForm.entryCode}
                  onChange={(e) => setWizardForm({ ...wizardForm, entryCode: e.target.value })}
                  placeholder="기본값: stock"
                />
                <p className="wizard-hint">
                  웹 화면에 접속할 때 요구되는 보안 입장 코드입니다. (기본값: <code>stock</code>)
                </p>
              </div>

              <div className="wizard-form-group">
                <label className="wizard-label">⚡ 시작 거래 모드 선택</label>
                <div className="wizard-choice-grid" style={{ marginBottom: "10px" }}>
                  <div
                    className={`wizard-choice-card ${wizardForm.tradeMode === "paper" ? "selected" : ""}`}
                    onClick={() => setWizardForm({ ...wizardForm, tradeMode: "paper" })}
                  >
                    <div className="wizard-choice-header">
                      <div className="wizard-choice-title">
                        <span>🟢 안전 가상거래(모의투자)</span>
                      </div>
                      <span className="wizard-choice-badge">권장</span>
                    </div>
                    <p className="wizard-choice-desc">
                      실제 자금 소모 없이 실시간 호가/시세 기반 10대 알고리즘 봇 경쟁 및 전략을 안전하게 테스트합니다.
                    </p>
                  </div>

                  <div
                    className={`wizard-choice-card ${wizardForm.tradeMode === "live" ? "selected" : ""}`}
                    onClick={() => setWizardForm({ ...wizardForm, tradeMode: "live" })}
                  >
                    <div className="wizard-choice-header">
                      <div className="wizard-choice-title">
                        <span>⚡ 업비트 실거래 모드</span>
                      </div>
                      <span className="wizard-choice-badge" style={{ background: "rgba(239, 68, 68, 0.2)", color: "#fca5a5", borderColor: "rgba(239, 68, 68, 0.4)" }}>
                        실전
                      </span>
                    </div>
                    <p className="wizard-choice-desc">
                      실제 업비트 계좌의 원화 잔고와 연동하여 1~3개 선정 봇이 실제 매수/매도 주문을 집행합니다.
                    </p>
                  </div>
                </div>
              </div>

              <div className="wizard-form-group">
                <label className="wizard-label">💰 초기 운용 시드 (KRW)</label>
                <input
                  type="number"
                  className="wizard-input"
                  value={wizardForm.initialCapital}
                  step={100000}
                  onChange={(e) => setWizardForm({ ...wizardForm, initialCapital: Math.max(100000, Number(e.target.value) || 0) })}
                  placeholder="10000000"
                />
                <p className="wizard-hint">
                  설정 금액: <strong>{Number(wizardForm.initialCapital).toLocaleString("ko-KR")}원</strong> (가상거래 기준 총 운영자본 또는 실전 운영기준치)
                </p>
              </div>

              <div className="wizard-footer">
                <div></div>
                <button
                  type="button"
                  className="wizard-btn-next"
                  onClick={() => setWizardStep(2)}
                  disabled={!wizardForm.entryCode.trim()}
                >
                  다음 단계 (데이터베이스 설정) ➔
                </button>
              </div>
            </div>
          )}

          {/* Step 2: 데이터베이스(DB) 환경 선택 */}
          {wizardStep === 2 && (
            <div>
              <div style={{ marginBottom: "18px" }}>
                <h3 style={{ fontSize: "16px", fontWeight: 700, color: "#f8fafc", marginBottom: "6px" }}>
                  데이터베이스(DB) 방식을 선택하세요
                </h3>
                <p style={{ fontSize: "13px", color: "#94a3b8" }}>
                  별도의 데이터베이스 서버가 없어도 프로그램 자체 내장 초고속 파일 DB(SQLite WAL)로 모든 기능을 100% 동일하게 사용할 수 있습니다.
                </p>
              </div>

              <div className="wizard-choice-grid">
                <div
                  className={`wizard-choice-card ${wizardForm.dbType === "sqlite" ? "selected" : ""}`}
                  onClick={() => setWizardForm({ ...wizardForm, dbType: "sqlite" })}
                >
                  <div className="wizard-choice-header">
                    <div className="wizard-choice-title">
                      <span>📂 DB 없음 (내장 SQLite 자동 사용)</span>
                    </div>
                    <span className="wizard-choice-badge">일반 사용자 권장</span>
                  </div>
                  <p className="wizard-choice-desc">
                    별도의 DB 서버 설치 없이 프로그램 내장 파일 DB(<code>data/auto_coin_trade.db</code>, SQLite WAL 고속 모드)를 자동으로 생성하고 단독으로 사용합니다. 에러나 복잡한 설정 없이 원클릭 구동이 가능합니다.
                  </p>
                </div>

                <div
                  className={`wizard-choice-card ${wizardForm.dbType === "server" ? "selected" : ""}`}
                  onClick={() => setWizardForm({ ...wizardForm, dbType: "server" })}
                >
                  <div className="wizard-choice-header">
                    <div className="wizard-choice-title">
                      <span>🗄️ DB 서버 있음 (PostgreSQL 직접 연결)</span>
                    </div>
                    <span className="wizard-choice-badge" style={{ background: "rgba(59, 130, 246, 0.2)", color: "#93c5fd", borderColor: "rgba(59, 130, 246, 0.4)" }}>
                      고급 사용자
                    </span>
                  </div>
                  <p className="wizard-choice-desc">
                    외부 또는 로컬에 구동 중인 PostgreSQL 서버에 접속하여 14개 필수 테이블을 자동 설치(`CREATE TABLE IF NOT EXISTS`)하고 실시간 동기화(`pg_sync.mjs`)를 가동합니다.
                  </p>
                </div>
              </div>

              {wizardForm.dbType === "server" && (
                <div style={{ background: "#0e1526", border: "1px solid #23314f", borderRadius: "12px", padding: "20px", marginBottom: "20px" }}>
                  <h4 style={{ fontSize: "14px", fontWeight: 700, color: "#93c5fd", marginBottom: "14px" }}>
                    🔌 PostgreSQL 서버 접속 정보 입력
                  </h4>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "12px", marginBottom: "12px" }}>
                    <div>
                      <label className="wizard-label">호스트 IP / 도메인</label>
                      <input
                        type="text"
                        className="wizard-input"
                        value={wizardForm.dbConfig.host}
                        onChange={(e) => setWizardForm({
                          ...wizardForm,
                          dbConfig: { ...wizardForm.dbConfig, host: e.target.value }
                        })}
                        placeholder="127.0.0.1"
                      />
                    </div>
                    <div>
                      <label className="wizard-label">포트 (기본 5432)</label>
                      <input
                        type="number"
                        className="wizard-input"
                        value={wizardForm.dbConfig.port}
                        onChange={(e) => setWizardForm({
                          ...wizardForm,
                          dbConfig: { ...wizardForm.dbConfig, port: Number(e.target.value) || 5432 }
                        })}
                        placeholder="5432"
                      />
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "14px" }}>
                    <div>
                      <label className="wizard-label">데이터베이스명</label>
                      <input
                        type="text"
                        className="wizard-input"
                        value={wizardForm.dbConfig.database}
                        onChange={(e) => setWizardForm({
                          ...wizardForm,
                          dbConfig: { ...wizardForm.dbConfig, database: e.target.value }
                        })}
                        placeholder="coin_trader"
                      />
                    </div>
                    <div>
                      <label className="wizard-label">계정 ID</label>
                      <input
                        type="text"
                        className="wizard-input"
                        value={wizardForm.dbConfig.user}
                        onChange={(e) => setWizardForm({
                          ...wizardForm,
                          dbConfig: { ...wizardForm.dbConfig, user: e.target.value }
                        })}
                        placeholder="coin_trader"
                      />
                    </div>
                    <div>
                      <label className="wizard-label">비밀번호</label>
                      <input
                        type="password"
                        className="wizard-input"
                        value={wizardForm.dbConfig.password}
                        onChange={(e) => setWizardForm({
                          ...wizardForm,
                          dbConfig: { ...wizardForm.dbConfig, password: e.target.value }
                        })}
                        placeholder="비밀번호"
                      />
                    </div>
                  </div>

                  <div className="wizard-test-box">
                    <button
                      type="button"
                      className="wizard-btn-test"
                      onClick={handleTestDbConnection}
                      disabled={dbTestState.loading}
                    >
                      {dbTestState.loading ? "연결 확인 중..." : "🔌 DB 서버 연결 테스트"}
                    </button>
                    {dbTestState.result && (
                      <span style={{ fontSize: "12.5px", color: "#34d399", fontWeight: 600 }}>
                        ✔ {dbTestState.result}
                      </span>
                    )}
                    {dbTestState.error && (
                      <span style={{ fontSize: "12.5px", color: "#f87171", fontWeight: 600 }}>
                        ✕ {dbTestState.error}
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="wizard-footer">
                <button
                  type="button"
                  className="wizard-btn-prev"
                  onClick={() => setWizardStep(1)}
                >
                  ◀ 이전 단계
                </button>
                <button
                  type="button"
                  className="wizard-btn-next"
                  onClick={() => setWizardStep(3)}
                >
                  다음 단계 (API 키 입력) ➔
                </button>
              </div>
            </div>
          )}

          {/* Step 3: 업비트 및 Gemini API 키 설정 */}
          {wizardStep === 3 && (
            <div>
              <div style={{ marginBottom: "18px" }}>
                <h3 style={{ fontSize: "16px", fontWeight: 700, color: "#f8fafc", marginBottom: "6px" }}>
                  거래소 및 AI API 키 연동
                </h3>
                <p style={{ fontSize: "13px", color: "#94a3b8" }}>
                  업비트 실거래 또는 안전 가상거래, 그리고 Gemini AI 시황/뉴스 분석을 위한 키를 입력합니다.
                </p>
              </div>

              {/* Upbit Key Group */}
              <div style={{ background: "#151d30", border: "1px solid #24304d", borderRadius: "12px", padding: "18px", marginBottom: "18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
                  <label className="wizard-label" style={{ margin: 0 }}>
                    🪙 업비트(Upbit) Open API 키
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#94a3b8", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={wizardForm.skipUpbit}
                      onChange={(e) => setWizardForm({ ...wizardForm, skipUpbit: e.target.checked })}
                    />
                    <span>가상거래만 먼저 사용할 경우 나중에 입력하기 (건너뛰기)</span>
                  </label>
                </div>

                {!wizardForm.skipUpbit ? (
                  <>
                    <div style={{ marginBottom: "10px" }}>
                      <input
                        type="text"
                        className="wizard-input"
                        value={wizardForm.upbitAccessKey}
                        onChange={(e) => setWizardForm({ ...wizardForm, upbitAccessKey: e.target.value })}
                        placeholder="Upbit Access Key 입력"
                      />
                    </div>
                    <div>
                      <input
                        type="password"
                        className="wizard-input"
                        value={wizardForm.upbitSecretKey}
                        onChange={(e) => setWizardForm({ ...wizardForm, upbitSecretKey: e.target.value })}
                        placeholder="Upbit Secret Key 입력"
                      />
                    </div>
                    <p className="wizard-hint">
                      * 업비트 고객센터 ➔ Open API 관리에서 발급받은 키를 입력하세요. (자산조회, 주문 권한 필수)
                    </p>
                  </>
                ) : (
                  <p style={{ margin: 0, fontSize: "12.5px", color: "#60a5fa" }}>
                    ℹ️ 업비트 키 입력을 건너뜁니다. 언제든 가상거래 모드로 10대 봇 경쟁을 즐길 수 있으며, 추후 [설정] 메뉴에서 실제 키를 등록할 수 있습니다.
                  </p>
                )}
              </div>

              {/* Gemini Key Group */}
              <div style={{ background: "#151d30", border: "1px solid #24304d", borderRadius: "12px", padding: "18px", marginBottom: "18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
                  <label className="wizard-label" style={{ margin: 0 }}>
                    🤖 Google Gemini AI API 키 (선택/권장)
                  </label>
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: "12px", color: "#818cf8", textDecoration: "none", fontWeight: 600 }}
                  >
                    Google AI Studio에서 무료 발급 ➔
                  </a>
                </div>
                <input
                  type="password"
                  className="wizard-input"
                  value={wizardForm.geminiApiKey}
                  onChange={(e) => setWizardForm({ ...wizardForm, geminiApiKey: e.target.value })}
                  placeholder="AI Studio에서 발급받은 Gemini API Key 입력 (미입력 시 룰베이스 분석 동작)"
                />
                <p className="wizard-hint">
                  30분 주기 Flash 시황·뉴스 분석 및 1시간 주기 Pro 심층 퀀트 교차검증에 사용됩니다. (무료 발급 가능)
                </p>
              </div>

              {/* Test Action */}
              <div className="wizard-test-box">
                <button
                  type="button"
                  className="wizard-btn-test"
                  onClick={handleTestApiKeys}
                  disabled={keysTestState.loading || (wizardForm.skipUpbit && !wizardForm.geminiApiKey)}
                >
                  {keysTestState.loading ? "API 키 검증 중..." : "🔑 API 키 연동 테스트"}
                </button>
                {keysTestState.result && (
                  <span style={{ fontSize: "12.5px", color: "#34d399", fontWeight: 600 }}>
                    ✔ {keysTestState.result}
                  </span>
                )}
                {keysTestState.error && (
                  <span style={{ fontSize: "12.5px", color: "#f87171", fontWeight: 600 }}>
                    ✕ {keysTestState.error}
                  </span>
                )}
              </div>

              <div className="wizard-footer">
                <button
                  type="button"
                  className="wizard-btn-prev"
                  onClick={() => setWizardStep(2)}
                >
                  ◀ 이전 단계
                </button>
                <button
                  type="button"
                  className="wizard-btn-next"
                  onClick={() => setWizardStep(4)}
                >
                  다음 단계 (최종 확인 및 자동 설치) ➔
                </button>
              </div>
            </div>
          )}

          {/* Step 4: 요약 확인 및 원클릭 자동 설치 & 서비스 시작 */}
          {wizardStep === 4 && (
            <div>
              <div style={{ marginBottom: "18px" }}>
                <h3 style={{ fontSize: "16px", fontWeight: 700, color: "#f8fafc", marginBottom: "6px" }}>
                  설정 내용 최종 확인 & 원클릭 자동 설치
                </h3>
                <p style={{ fontSize: "13px", color: "#94a3b8" }}>
                  입력하신 구성을 확인하고 [설정 저장 및 프로그램 자동 설치·구동] 버튼을 누르면 모든 환경 구성이 완료됩니다.
                </p>
              </div>

              {/* Summary Card */}
              <div style={{ background: "#151d30", border: "1px solid #24304d", borderRadius: "12px", padding: "18px", marginBottom: "20px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" }}>
                  <div>
                    <span style={{ fontSize: "11.5px", color: "#64748b", display: "block" }}>보안 입장 코드</span>
                    <strong style={{ fontSize: "14px", color: "#f8fafc" }}>{wizardForm.entryCode}</strong>
                  </div>
                  <div>
                    <span style={{ fontSize: "11.5px", color: "#64748b", display: "block" }}>시작 거래 모드</span>
                    <strong style={{ fontSize: "14px", color: wizardForm.tradeMode === "paper" ? "#34d399" : "#f87171" }}>
                      {wizardForm.tradeMode === "paper" ? "🟢 안전 가상거래(모의투자)" : "⚡ 업비트 실거래"}
                    </strong>
                  </div>
                  <div>
                    <span style={{ fontSize: "11.5px", color: "#64748b", display: "block" }}>운용 원금(KRW)</span>
                    <strong style={{ fontSize: "14px", color: "#f8fafc" }}>{Number(wizardForm.initialCapital).toLocaleString("ko-KR")}원</strong>
                  </div>
                  <div>
                    <span style={{ fontSize: "11.5px", color: "#64748b", display: "block" }}>데이터베이스(DB) 모드</span>
                    <strong style={{ fontSize: "14px", color: "#93c5fd" }}>
                      {wizardForm.dbType === "sqlite" ? "📂 내장 SQLite 파일 DB (WAL 고속)" : `🗄️ PostgreSQL (${wizardForm.dbConfig.host}:${wizardForm.dbConfig.port})`}
                    </strong>
                  </div>
                  <div>
                    <span style={{ fontSize: "11.5px", color: "#64748b", display: "block" }}>업비트 거래소 연동</span>
                    <strong style={{ fontSize: "14px", color: wizardForm.skipUpbit ? "#94a3b8" : "#34d399" }}>
                      {wizardForm.skipUpbit ? "건너뜀 (가상거래 모드 전용)" : "등록됨 (API 키 연동)"}
                    </strong>
                  </div>
                  <div>
                    <span style={{ fontSize: "11.5px", color: "#64748b", display: "block" }}>Gemini AI 분석</span>
                    <strong style={{ fontSize: "14px", color: wizardForm.geminiApiKey ? "#818cf8" : "#94a3b8" }}>
                      {wizardForm.geminiApiKey ? "등록됨 (듀얼 AI 엔진 가동)" : "미등록 (기본 룰 분석)"}
                    </strong>
                  </div>
                </div>
              </div>

              {/* Installation Progress & Checklist */}
              {installState.installing ? (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                    <span style={{ fontSize: "13.5px", fontWeight: 700, color: "#818cf8" }}>
                      ⚙️ 시스템 자동 설치 및 백그라운드 엔진 기동 중...
                    </span>
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                      {installState.progress}%
                    </span>
                  </div>
                  <div className="wizard-progress-track">
                    <div className="wizard-progress-bar" style={{ width: `${installState.progress}%` }}></div>
                  </div>

                  <div className="wizard-checklist">
                    {[
                      "설정 파일 생성 완료 (.env 및 config/upbit_config.json)",
                      "데이터베이스 스키마 및 인덱스 자동 설치 완료",
                      "10대 알고리즘 봇 계좌 및 전략 엔진 초기화 완료",
                      "백그라운드 AI 브리핑 및 실시간 시세 워커 기동 완료",
                      "웹 대시보드 화면 진입 준비 완료",
                    ].map((stepText, idx) => {
                      const isDone = installState.currentStepIndex > idx;
                      const isCur = installState.currentStepIndex === idx;
                      return (
                        <div
                          key={idx}
                          className={`wizard-check-item ${isDone ? "done" : ""} ${isCur ? "active" : ""}`}
                        >
                          <span>{isDone ? "✔" : isCur ? "⏳" : "○"}</span>
                          <span>{stepText}</span>
                        </div>
                      );
                    })}
                  </div>

                  {installState.error && (
                    <div style={{ padding: "12px", background: "rgba(239, 68, 68, 0.15)", border: "1px solid #ef4444", borderRadius: "8px", color: "#fca5a5", fontSize: "13px", marginTop: "12px" }}>
                      ✕ {installState.error}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "10px 0" }}>
                  <button
                    type="button"
                    className="wizard-btn-next"
                    style={{
                      width: "100%",
                      justifyContent: "center",
                      padding: "16px 24px",
                      fontSize: "16px",
                      background: "linear-gradient(135deg, #4f46e5, #059669)",
                      borderColor: "#34d399",
                      boxShadow: "0 8px 24px rgba(16, 185, 129, 0.35)",
                    }}
                    onClick={handleCompleteSetup}
                  >
                    <span>🚀 설정 저장 및 프로그램 자동 설치·구동 시작</span>
                  </button>
                  <p style={{ fontSize: "12px", color: "#64748b", marginTop: "10px" }}>
                    클릭 시 설정이 저장되고 DB가 즉시 초기화되며 백그라운드 엔진이 가동됩니다.
                  </p>
                </div>
              )}

              <div className="wizard-footer">
                <button
                  type="button"
                  className="wizard-btn-prev"
                  onClick={() => setWizardStep(3)}
                  disabled={installState.installing}
                >
                  ◀ 이전 단계
                </button>
                <div></div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // 입장 코드 화면 (기본: stock)
  // ------------------------------------------------------------------
  if (!authenticated) {
    return (
      <div className="gate-wrapper">
        <div className="gate-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <span className="gate-badge" style={{ margin: 0 }}>UPBIT QUANT AUTO TRADER</span>
            <button
              type="button"
              className="version-pill-badge"
              onClick={openHistoryModal}
              title="클릭하여 버전별 수정내역(history.md) 확인"
            >
              v{appVersion}
            </button>
          </div>
          <h1 className="gate-title">코인 자동매매 시스템</h1>
          <p className="gate-subtitle">
            개인 전용 보안 화면입니다. 진입을 위해 입장 코드를 입력해주세요.
          </p>
          <form onSubmit={handleVerifyEntryCode}>
            <input
              type="password"
              className="gate-input"
              placeholder="입장 코드 입력 (기본: stock)"
              value={entryCodeInput}
              onChange={(e) => setEntryCodeInput(e.target.value)}
              autoFocus
            />
            {gateError && <div className="gate-error">{gateError}</div>}
            <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
              입장하기
            </button>
          </form>
          <div style={{ marginTop: "16px", textAlign: "center" }}>
            <button
              type="button"
              onClick={openHistoryModal}
              style={{
                background: "none",
                border: "none",
                color: "#64748b",
                fontSize: "12px",
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              📜 버전 변경 이력 (history.md v{appVersion}) 확인
            </button>
          </div>
        </div>
        {renderHistoryModal()}
      </div>
    );
  }

  const chartSeries =
    statsPeriodTab === "daily"
      ? stats.daily
      : statsPeriodTab === "weekly"
      ? stats.weekly
      : stats.monthly;

  const periodLabel =
    statsPeriodTab === "daily" ? "일간" : statsPeriodTab === "weekly" ? "주간" : "월간";

  // ------------------------------------------------------------------
  // 내부 메인 화면 (요구사항 7: 좌측 메뉴 2 : 우측 상세 화면 8 비율)
  // ------------------------------------------------------------------
  return (
    <div className="app-layout">
      {/* 좌측 메뉴 영역 (20%) */}
      <aside className="left-sidebar">
        <div className="sidebar-top-section">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "0 4px 14px 4px",
              borderBottom: "1px solid var(--border-color)",
              marginBottom: "16px",
            }}
          >
            <div className="brand-header" style={{ margin: 0, padding: 0, border: "none" }}>
              Upbit AutoTrade
            </div>
            <button
              type="button"
              className="version-pill-badge"
              onClick={openHistoryModal}
              title="클릭하여 프로젝트 버전별 상세 변경이력(history.md) 확인"
            >
              v{appVersion}
            </button>
          </div>

          {/* 요구사항 19: 메뉴 상단 업비트 통신 상태 식별 영역 (초록/노랑/빨강 + 마우스 오버 사유 표기) */}
          <div className="upbit-status-box">
            <div className="status-header-row">
              <span className="status-title">업비트 Open API 통신 상태</span>
              <div className="status-indicator-wrap">
                <span className={`status-dot ${upbitStatus.status || "green"}`} />
                <span className={`status-label-text ${upbitStatus.status || "green"}`}>
                  {upbitStatus.label || "정상통신"}
                </span>
              </div>
            </div>
            <div className="status-help-hint" style={{ fontSize: "11.5px", color: "#94a3b8" }}>
              마우스를 올리면 상세 통신 사유를 확인합니다.
            </div>

            {/* 마우스 오버 시 나타나는 상세 이유 툴팁 */}
            <div className="status-Tooltip">
              <div style={{ fontWeight: 700, marginBottom: "6px", color: "#fff" }}>
                [통신 상태 상세 사유]
              </div>
              <div>• 상태: {upbitStatus.label}</div>
              <div>• 사유: {upbitStatus.reason}</div>
              <div>• 응답속도: {upbitStatus.latency_ms ?? 0} ms</div>
              <div>• 최근확인: {upbitStatus.checked_at || "-"}</div>
            </div>
          </div>

          {/* 실시간 거래 모드 전환 버튼 (가상거래 모의투자 ↔ 실거래) */}
          <div className="trade-mode-chip-container">
            <button
              type="button"
              className={`mode-toggle-chip ${tradeMode.mode === "paper" ? "chip-paper" : "chip-live"}`}
              onClick={() => handleToggleTradeMode()}
              disabled={tradeMode.loading}
              title="클릭하여 실거래 / 가상거래(모의투자) 모드를 전환합니다."
            >
              <span className={`mode-dot ${tradeMode.mode === "paper" ? "paper" : "live"}`} />
              <span className="mode-text">
                {tradeMode.mode === "paper" ? "🧪 가상거래(모의)" : "⚡ 업비트 실거래"}
              </span>
              <span className="mode-switch-hint">전환 ⇄</span>
            </button>
          </div>
        </div>

        {/* 메뉴 구성 (거래현황, 통계, 알고리즘 검증소, 뉴스, 설정) */}
        <nav className="menu-list">
          <button
            className={`menu-btn ${activeMenu === "trades" ? "active" : ""}`}
            onClick={() => handleMenuChange("trades")}
            title="내가 선택한 1~3개 실전 담당 봇 전용 제어 및 업비트 실계좌 체결 현황"
          >
            <span>⚡</span>
            <span>실제거래 현황</span>
          </button>
          <button
            className={`menu-btn ${activeMenu === "arena" || activeMenu === "algo-lab" ? "active" : ""}`}
            onClick={() => handleMenuChange("arena")}
            title="10개 봇 상시 무중단 거래 및 순수 알고리즘 수익률 리더보드"
          >
            <span>🏆</span>
            <span>가상거래 경쟁</span>
          </button>
          <button
            className={`menu-btn ${activeMenu === "stats" ? "active" : ""}`}
            onClick={() => handleMenuChange("stats")}
          >
            <span>📈</span>
            <span>통계</span>
          </button>
          <button
            className={`menu-btn ${activeMenu === "news" ? "active" : ""}`}
            onClick={() => handleMenuChange("news")}
          >
            <span>📰</span>
            <span>뉴스</span>
          </button>
          <button
            className={`menu-btn ${activeMenu === "settings" ? "active" : ""}`}
            onClick={() => handleMenuChange("settings")}
            title="실전 담당 봇 1~3개 선택 및 동적 투자금 비율 설정 패널"
          >
            <span>⚙️</span>
            <span>설정</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <span>모드:</span>
            <span
              style={{
                fontWeight: 700,
                color: tradeMode.mode === "paper" ? "#a5b4fc" : "#ef4444",
                cursor: "pointer",
              }}
              onClick={() => handleToggleTradeMode()}
              title="클릭하여 모드 전환"
            >
              {tradeMode.mode === "paper" ? "🧪 가상거래(모의)" : "⚡ 업비트 실거래"}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
            <span>시스템 버전:</span>
            <span
              style={{ color: "#38bdf8", fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}
              onClick={openHistoryModal}
              title="클릭하여 상세 변경이력(history.md) 확인"
            >
              v{appVersion}
            </span>
          </div>
          <div>DB: SQLite (WAL / 자동 재접속)</div>
          <div style={{ marginTop: "4px" }}>Rate Limit: 0.12s 방어 적용</div>
        </div>
      </aside>

      {/* 우측 상세 화면 영역 (80%) */}
      <main className="right-content">
        {/* ============================================================
            [메뉴 1] 거래현황 (요구사항 9, 20, 21)
           ============================================================ */}
        {activeMenu === "trades" && (
          <div>
            {isLiveConfigDirty && (
              <div
                className="card"
                style={{
                  marginBottom: "16px",
                  background: "linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(185, 28, 28, 0.35))",
                  border: "2px solid #ef4444",
                  padding: "16px 20px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <span style={{ fontSize: "24px" }}>⚠️</span>
                  <div>
                    <strong style={{ color: "#fca5a5", fontSize: "15px" }}>
                      실전 봇 구성 또는 투자금 비율 설정이 변경되었습니다! (저장 미완료)
                    </strong>
                    <div style={{ fontSize: "12.5px", color: "#f1f5f9", marginTop: "4px" }}>
                      설정 메뉴에서 비율(합계 100%)을 확인하시고 <strong>[💾 실전 거래 담당 봇 및 투자금 설정 저장]</strong> 버튼을 완료해야 실제 투자를 진행할 수 있습니다.
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleMenuChange("settings")}
                  style={{ padding: "8px 16px", fontSize: "13px", fontWeight: 700 }}
                >
                  ⚙️ 설정으로 이동하여 저장 완료하기
                </button>
              </div>
            )}

            <div className="page-header">
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <h2 className="page-title">⚡ 실제거래 현황</h2>
                  <span
                    style={{
                      fontSize: "12px",
                      padding: "3px 10px",
                      borderRadius: "12px",
                      background: "rgba(239, 68, 68, 0.2)",
                      color: "#fca5a5",
                      border: "1px solid rgba(239, 68, 68, 0.4)",
                      fontWeight: 700,
                    }}
                  >
                    실계좌 연동 · 실전 전용
                  </span>
                </div>
                <p className="page-desc">
                  설정에서 선택된 1~3개의 실전 담당 봇만 노출되며, 실제 업비트 계좌의 자금과 연동되어 안전하게 매매를 수행합니다.
                </p>
              </div>
            </div>

            {/* 가상거래 / 실거래 모드 상태 안내 카드 */}
            <div
              className="card"
              style={{
                marginBottom: "16px",
                padding: "12px 18px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "10px",
                background:
                  tradeMode.mode === "paper"
                    ? "linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(30, 27, 75, 0.35) 100%)"
                    : "linear-gradient(135deg, rgba(239, 68, 68, 0.12) 0%, rgba(69, 10, 10, 0.25) 100%)",
                borderColor: tradeMode.mode === "paper" ? "rgba(99, 102, 241, 0.45)" : "rgba(239, 68, 68, 0.45)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span style={{ fontSize: "22px" }}>{tradeMode.mode === "paper" ? "🧪" : "⚡"}</span>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <strong style={{ fontSize: "15px", color: tradeMode.mode === "paper" ? "#c7d2fe" : "#fca5a5" }}>
                      {tradeMode.mode === "paper" ? "현재 [가상거래 모의투자] 모드 동작 중" : "현재 [업비트 실거래] 모드 동작 중"}
                    </strong>
                    <span
                      style={{
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "10px",
                        fontWeight: 700,
                        background: tradeMode.mode === "paper" ? "#4338ca" : "#b91c1c",
                        color: "#ffffff",
                      }}
                    >
                      {tradeMode.mode === "paper" ? "PAPER" : "LIVE"}
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "3px" }}>
                    {tradeMode.mode === "paper"
                      ? "실거래와 분리된 전용 가상 원장(paper_trades)에 체결 내역이 안전하게 기록됩니다. 초기화 후 처음부터 다시 거래하며 실시간 랭킹을 관찰할 수 있습니다."
                      : "업비트 실계좌 API 키를 통해 실제 원화 잔고로 매수/매도 주문이 거래소에 직접 전송됩니다."}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                {tradeMode.mode === "paper" && (
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={handleResetPaperTrades}
                    disabled={paperResetLoading}
                    style={{ padding: "8px 14px", fontSize: "12.5px", borderColor: "#818cf8", color: "#c7d2fe" }}
                    title="가상거래 체결 이력 및 포지션을 삭제하고 알고리즘 검증소 모델(100만 원)을 초기화하여 처음부터 다시 거래합니다."
                  >
                    {paperResetLoading ? "초기화 중..." : "🔄 가상거래 이력 초기화"}
                  </button>
                )}
                <button
                  type="button"
                  className={`btn ${tradeMode.mode === "paper" ? "btn-primary" : "btn-stop"}`}
                  onClick={() => handleToggleTradeMode()}
                  disabled={tradeMode.loading}
                  style={{ padding: "8px 16px", fontSize: "12.5px" }}
                >
                  {tradeMode.loading ? "모드 전환 중..." : tradeMode.mode === "paper" ? "⚡ 실거래 모드로 전환" : "🧪 가상거래 모드로 전환"}
                </button>
              </div>
            </div>

            {/* 거래현황 상단: 업비트 실계좌 조회 요약 (총 매수금액 / 총 평가금액 / 주문 가능 금액) */}
            <div className="card" style={{ marginBottom: "18px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "12px",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <div style={{ fontSize: "15px", fontWeight: 700, color: "#f8fafc" }}>
                  업비트 실계좌 자산 현황{" "}
                  {upbitAccount.checked_at && (
                    <span style={{ fontSize: "12px", fontWeight: 400, color: "#94a3b8", marginLeft: "8px" }}>
                      (조회 시각: {upbitAccount.checked_at})
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: "5px 12px", fontSize: "12px" }}
                  onClick={fetchUpbitAccount}
                  disabled={upbitAccount.loading}
                >
                  {upbitAccount.loading ? "조회 중..." : "업비트 자산 새로고침"}
                </button>
              </div>

              {!upbitAccount.success && (
                <div
                  style={{
                    fontSize: "12.5px",
                    color: "#f87171",
                    background: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    borderRadius: "8px",
                    padding: "8px 12px",
                    marginBottom: "12px",
                  }}
                >
                  {upbitAccount.message || "업비트 실계좌 정보를 불러오지 못했습니다."}
                </div>
              )}

              <div
                className="bot-meta-grid"
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
              >
                <div className="meta-item">
                  <span className="meta-label">총 매수금액</span>
                  <span className="meta-value" style={{ fontSize: "18px", color: "#f8fafc" }}>
                    {upbitAccount.success && upbitAccount.total_buy_krw !== null
                      ? `${Number(upbitAccount.total_buy_krw).toLocaleString("ko-KR")}원`
                      : "-"}
                  </span>
                </div>

                <div className="meta-item">
                  <span className="meta-label">총 평가금액</span>
                  <span
                    className="meta-value"
                    style={{
                      fontSize: "18px",
                      color:
                        upbitAccount.success && upbitAccount.eval_profit_krw > 0
                          ? "#ef4444"
                          : upbitAccount.success && upbitAccount.eval_profit_krw < 0
                          ? "#3b82f6"
                          : "#f8fafc",
                    }}
                  >
                    {upbitAccount.success && upbitAccount.total_eval_krw !== null
                      ? `${Number(upbitAccount.total_eval_krw).toLocaleString("ko-KR")}원`
                      : "-"}
                    {upbitAccount.success && upbitAccount.eval_profit_krw !== null && (
                      <span style={{ fontSize: "12.5px", marginLeft: "6px", fontWeight: 600 }}>
                        ({upbitAccount.eval_profit_krw > 0 ? "+" : ""}
                        {Number(upbitAccount.eval_profit_krw).toLocaleString("ko-KR")}원 /{" "}
                        {upbitAccount.eval_profit_pct > 0 ? "+" : ""}
                        {upbitAccount.eval_profit_pct}%)
                      </span>
                    )}
                  </span>
                </div>

                <div className="meta-item">
                  <span className="meta-label">주문 가능 금액</span>
                  <span className="meta-value" style={{ fontSize: "18px", color: "#38bdf8" }}>
                    {upbitAccount.success && upbitAccount.orderable_krw !== null
                      ? `${Number(upbitAccount.orderable_krw).toLocaleString("ko-KR")}원`
                      : "-"}
                  </span>
                </div>
              </div>
            </div>

            {/* AI 주간 최적 봇 자동 편성 카드 (1주일 주기) */}
            <div
              className="card"
              style={{
                marginBottom: "18px",
                background: "linear-gradient(135deg, rgba(30, 27, 75, 0.55) 0%, rgba(15, 23, 42, 0.85) 100%)",
                border: "1px solid rgba(168, 85, 247, 0.35)",
                boxShadow: "0 8px 24px -4px rgba(168, 85, 247, 0.12)",
                borderRadius: "12px",
                padding: "16px 20px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: isWeeklyBotExpanded ? "14px" : "0" }}>
                <div
                  style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}
                  onClick={() => setIsWeeklyBotExpanded((prev) => !prev)}
                >
                  <span style={{ fontSize: "16px", fontWeight: 700, color: "#f8fafc" }}>
                    🤖 AI 주간 봇 자동 추천 & 편성 (매주 일요일 09:00)
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: "10px",
                      background: "rgba(168, 85, 247, 0.2)",
                      color: "#c084fc",
                      border: "1px solid rgba(168, 85, 247, 0.4)",
                    }}
                  >
                    {weeklyBotSelection?.days_remaining !== undefined ? `차기 갱신 D-${weeklyBotSelection.days_remaining}일` : "매주 일요일 09:00"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: "11.5px", padding: "4px 10px", borderColor: "rgba(168, 85, 247, 0.4)", color: "#c084fc" }}
                    onClick={triggerWeeklyBotSelection}
                    disabled={weeklyBotLoading}
                  >
                    {weeklyBotLoading ? "AI 평가 중..." : "⚡ 지금 AI 평가 실행"}
                  </button>
                  <button
                    style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "16px" }}
                    onClick={() => setIsWeeklyBotExpanded((prev) => !prev)}
                  >
                    {isWeeklyBotExpanded ? "▲" : "▼"}
                  </button>
                </div>
              </div>

              {isWeeklyBotExpanded && (
                <div style={{ fontSize: "13px", color: "#e2e8f0" }}>
                  {weeklyBotSelection?.selection?.market_assessment && (
                    <div style={{ marginBottom: "12px", padding: "10px 14px", background: "rgba(15, 23, 42, 0.6)", borderRadius: "8px", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
                      <div style={{ fontSize: "11.5px", fontWeight: 700, color: "#94a3b8", marginBottom: "4px" }}>
                        📊 AI 시장 체제 진단 & 포트폴리오 전략:
                      </div>
                      <div style={{ color: "#cbd5e1", lineHeight: 1.5 }}>
                        {weeklyBotSelection.selection.market_assessment}
                      </div>
                      {weeklyBotSelection.selection.portfolio_strategy && (
                        <div style={{ fontSize: "12px", color: "#a5b4fc", marginTop: "4px" }}>
                          💡 운용 방향: {weeklyBotSelection.selection.portfolio_strategy}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 1, 2, 3위 봇 리스트 */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "10px" }}>
                    {(weeklyBotSelection?.selection?.selected_bots || []).map((b) => (
                      <div
                        key={b.bot_id}
                        style={{
                          padding: "10px 14px",
                          background: "rgba(15, 23, 42, 0.7)",
                          borderRadius: "8px",
                          border: `1px solid ${b.rank === 1 ? "rgba(251, 191, 36, 0.4)" : b.rank === 2 ? "rgba(148, 163, 184, 0.3)" : "rgba(180, 83, 9, 0.3)"}`,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 800, color: b.rank === 1 ? "#fbbf24" : b.rank === 2 ? "#e2e8f0" : "#d97706" }}>
                            {b.rank === 1 ? "🥇 1위" : b.rank === 2 ? "🥈 2위" : "🥉 3위"} {b.nickname}
                          </span>
                          <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: "rgba(99, 102, 241, 0.2)", color: "#a5b4fc" }}>
                            비중 {(Number(b.allocation_ratio) * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div style={{ fontSize: "11px", color: "#94a3b8", marginBottom: "4px" }}>
                          전략: {b.strategy_type || b.name}
                        </div>
                        <div style={{ fontSize: "11.5px", color: "#cbd5e1", lineHeight: 1.4 }}>
                          {b.reason}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#64748b", marginTop: "10px" }}>
                    <span>최근 편성 일시: {formatDateTimeKST(weeklyBotSelection?.last_run)}</span>
                    <span>차기 자동 갱신: {weeklyBotSelection?.next_scheduled_run ? `${formatDateTimeKST(weeklyBotSelection.next_scheduled_run)} (매주 일요일 09:00)` : "매주 일요일 09:00"}</span>
                  </div>
                </div>
              )}
            </div>

            {/* AI 실시간 시장 분석 및 봇 진단 카드 (Gemini 3.5 Flash) */}
            <div
              className="card"
              style={{
                marginBottom: "18px",
                background: "linear-gradient(135deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0.85) 100%)",
                border: "1px solid rgba(99, 102, 241, 0.3)",
                boxShadow: "0 8px 24px -4px rgba(99, 102, 241, 0.12)",
                borderRadius: "12px",
                padding: isAiBriefingExpanded ? "18px 20px" : "12px 18px",
                transition: "all 0.25s ease-in-out",
              }}
            >
              {/* 상단 헤더: 타이틀 + 뱃지 + 간략정보 + 액션 버튼 */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                  borderBottom: isAiBriefingExpanded ? "1px solid rgba(255, 255, 255, 0.08)" : "none",
                  paddingBottom: isAiBriefingExpanded ? "12px" : "0",
                  marginBottom: isAiBriefingExpanded ? "14px" : "0",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "32px",
                      height: "32px",
                      borderRadius: "8px",
                      background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
                      fontSize: "16px",
                      cursor: "pointer",
                    }}
                    onClick={() => setIsAiBriefingExpanded((prev) => !prev)}
                    title={isAiBriefingExpanded ? "분석 영역 접기" : "분석 영역 펼치기"}
                  >
                    🤖
                  </div>
                  <div
                    style={{ cursor: "pointer" }}
                    onClick={() => setIsAiBriefingExpanded((prev) => !prev)}
                    title={isAiBriefingExpanded ? "분석 영역 접기" : "분석 영역 펼치기"}
                  >
                    <span style={{ fontSize: "16px", fontWeight: 700, color: "#f8fafc" }}>
                      AI 실시간 시장 분석 & 봇 진단
                    </span>
                    <span
                      style={{
                        marginLeft: "8px",
                        fontSize: "11px",
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: "12px",
                        background: "rgba(99, 102, 241, 0.2)",
                        color: "#a5b4fc",
                        border: "1px solid rgba(99, 102, 241, 0.4)",
                      }}
                      title="30분 단위 Gemini Flash 빠른 분석과 1시간 단위 Gemini Pro 심층 퀀트 분석 듀얼 엔진"
                    >
                      ⚡ Gemini Flash(30m) & Pro(1h) 듀얼 엔진
                    </span>
                    <span
                      style={{
                        marginLeft: "6px",
                        fontSize: "11px",
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: "12px",
                        background: "rgba(56, 189, 248, 0.15)",
                        color: "#38bdf8",
                        border: "1px solid rgba(56, 189, 248, 0.35)",
                      }}
                      title={
                        geminiQuota?.next_scheduled_at
                          ? `Flash 30분 및 Pro 1시간 자동 교차 검증 (다음 자동 분석: ${geminiQuota.next_scheduled_at})`
                          : "Flash 30분 / Pro 1시간 주기 자동 교차 검증"
                      }
                    >
                      ⏰ Flash 30분 · Pro 1시간 자동 교차 검증
                    </span>
                  </div>
                  {aiBriefing?.latest && (
                    <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                      (분석 시각: {aiBriefing.latest.created_at} ·{" "}
                      {aiBriefing?.last_trigger_type === "AUTO" ? "자동 분석" : "수동 분석"})
                    </span>
                  )}
                  {/* 접혀있을 때 듀얼 AI 교차검증 간략 요약 뱃지 표시 */}
                  {!isAiBriefingExpanded && aiBriefing?.latest && (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginLeft: "4px" }}>
                      {(() => {
                        const rf = aiBriefing?.regime_filter;
                        if (rf) {
                          const isBlocked = rf.final_risk_alert || rf.final_position_multiplier === 0;
                          const isReduced = !isBlocked && rf.final_position_multiplier <= 0.5;
                          return (
                            <>
                              <span
                                style={{
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  padding: "2px 6px",
                                  borderRadius: "6px",
                                  background: "rgba(56, 189, 248, 0.15)",
                                  color: "#38bdf8",
                                  border: "1px solid rgba(56, 189, 248, 0.35)",
                                }}
                                title={`Flash 30분 단기 분석: ${rf.flash_recommended_action} (점수: ${(Number(rf.flash_sentiment_score) || 0).toFixed(2)})`}
                              >
                                ⚡ Flash: {rf.flash_recommended_action || "NORMAL"}
                              </span>
                              <span
                                style={{
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  padding: "2px 6px",
                                  borderRadius: "6px",
                                  background: "rgba(168, 85, 247, 0.15)",
                                  color: "#c084fc",
                                  border: "1px solid rgba(168, 85, 247, 0.35)",
                                }}
                                title={`Pro 1시간 심층 퀀트 분석: ${rf.pro_recommended_action} (점수: ${(Number(rf.pro_sentiment_score) || 0).toFixed(2)})`}
                              >
                                🧠 Pro: {rf.pro_recommended_action || "NORMAL"}
                              </span>
                              <span
                                style={{
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  padding: "2px 8px",
                                  borderRadius: "6px",
                                  background: isBlocked
                                    ? "rgba(239, 68, 68, 0.2)"
                                    : isReduced
                                    ? "rgba(234, 179, 8, 0.2)"
                                    : "rgba(34, 197, 94, 0.2)",
                                  color: isBlocked ? "#f87171" : isReduced ? "#facc15" : "#4ade80",
                                  border: `1px solid ${
                                    isBlocked
                                      ? "rgba(239, 68, 68, 0.4)"
                                      : isReduced
                                      ? "rgba(234, 179, 8, 0.4)"
                                      : "rgba(34, 197, 94, 0.4)"
                                  }`,
                                }}
                                title={`듀얼 AI 교차검증 결론: ${rf.reason || ""}`}
                              >
                                {isBlocked
                                  ? "🛡️ 최종: 신규매수차단"
                                  : isReduced
                                  ? `🛡️ 최종: 비중 ${(rf.final_position_multiplier * 100).toFixed(0)}%`
                                  : "🛡️ 최종: 100% 정상거래"}
                              </span>
                            </>
                          );
                        }
                        return (
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              padding: "2px 8px",
                              borderRadius: "6px",
                              background:
                                aiBriefing.latest.regime_status === "HOLD_CASH"
                                  ? "rgba(239, 68, 68, 0.2)"
                                  : "rgba(34, 197, 94, 0.2)",
                              color:
                                aiBriefing.latest.regime_status === "HOLD_CASH" ? "#f87171" : "#4ade80",
                              border: `1px solid ${
                                aiBriefing.latest.regime_status === "HOLD_CASH"
                                  ? "rgba(239, 68, 68, 0.4)"
                                  : "rgba(34, 197, 94, 0.4)"
                              }`,
                            }}
                          >
                            {aiBriefing.latest.regime_status === "HOLD_CASH" ? "🔴 신규매수차단" : "🟢 정상거래 허용"}
                          </span>
                        );
                      })()}
                      {aiBriefing.latest.btc_price && (
                        <span style={{ fontSize: "12px", color: "#cbd5e1" }}>
                          BTC {Number(aiBriefing.latest.btc_price).toLocaleString("ko-KR")}원
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="ai-briefing-action-btns">
                  <span
                    style={{
                      fontSize: "11.5px",
                      fontWeight: 700,
                      padding: "5px 10px",
                      borderRadius: "8px",
                      background:
                        Number(geminiQuota?.remaining_calls ?? 30) <= 0
                          ? "rgba(239, 68, 68, 0.18)"
                          : Number(geminiQuota?.remaining_calls ?? 30) <= 3
                          ? "rgba(234, 179, 8, 0.18)"
                          : "rgba(16, 185, 129, 0.16)",
                      color:
                        Number(geminiQuota?.remaining_calls ?? 30) <= 0
                          ? "#f87171"
                          : Number(geminiQuota?.remaining_calls ?? 30) <= 3
                          ? "#facc15"
                          : "#34d399",
                      border: `1px solid ${
                        Number(geminiQuota?.remaining_calls ?? 30) <= 0
                          ? "rgba(239, 68, 68, 0.4)"
                          : Number(geminiQuota?.remaining_calls ?? 30) <= 3
                          ? "rgba(234, 179, 8, 0.4)"
                          : "rgba(16, 185, 129, 0.35)"
                      }`,
                    }}
                    title={`일일 무료 한도 총 ${geminiQuota?.daily_total_limit ?? 50}건 중 자동 분석 예약(${geminiQuota?.auto_reserved_count ?? 6}건)을 제외한 수동 호출 잔여 건수`}
                  >
                    무료 API 잔여: {geminiQuota?.remaining_calls ?? 30}/{geminiQuota?.manual_limit ?? 30}건 (자동예약{" "}
                    {geminiQuota?.auto_reserved_count ?? 6}건 제외)
                  </span>

                  <button
                    type="button"
                    className="btn"
                    style={{
                      background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
                      color: "#fff",
                      border: "none",
                      padding: "6px 14px",
                      fontSize: "12.5px",
                      fontWeight: 600,
                      borderRadius: "8px",
                      cursor: aiLoading || isStreaming ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)",
                      opacity: aiLoading || isStreaming ? 0.75 : 1,
                    }}
                    onClick={triggerAiAnalysis}
                    disabled={aiLoading || isStreaming}
                  >
                    {isStreaming ? (
                      <>
                        <span className="spinner" style={{ width: "13px", height: "13px" }} />
                        실시간 스트리밍 중...
                      </>
                    ) : aiLoading ? (
                      <>
                        <span className="spinner" style={{ width: "13px", height: "13px" }} />
                        Gemini 연결 중...
                      </>
                    ) : (
                      <>⚡ AI 시황 분석 요청 ({geminiQuota?.remaining_calls ?? 30}건 남음)</>
                    )}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{
                      padding: "6px 12px",
                      fontSize: "12px",
                      background: "rgba(51, 65, 85, 0.6)",
                      border: "1px solid rgba(148, 163, 184, 0.2)",
                    }}
                    onClick={() => {
                      setShowAiKeyConfig((prev) => {
                        const next = !prev;
                        if (next) setIsAiBriefingExpanded(true);
                        return next;
                      });
                    }}
                  >
                    ⚙️ {aiBriefing?.has_key ? "API 키 설정됨" : "API 키 등록"}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{
                      padding: "6px 12px",
                      fontSize: "12.5px",
                      fontWeight: 600,
                      background: isAiBriefingExpanded
                        ? "rgba(99, 102, 241, 0.25)"
                        : "rgba(51, 65, 85, 0.7)",
                      color: isAiBriefingExpanded ? "#c7d2fe" : "#f1f5f9",
                      border: isAiBriefingExpanded
                        ? "1px solid rgba(129, 140, 248, 0.5)"
                        : "1px solid rgba(148, 163, 184, 0.3)",
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      cursor: "pointer",
                    }}
                    onClick={() => setIsAiBriefingExpanded((prev) => !prev)}
                    title={isAiBriefingExpanded ? "분석 영역 접기" : "분석 영역 펼치기"}
                  >
                    {isAiBriefingExpanded ? "▲ 분석 접기" : "▼ 분석 펼치기"}
                  </button>
                </div>
              </div>

              {/* 분석 영역 본문 (접힘/펼침 제어) */}
              {isAiBriefingExpanded && (
                <div>
                  {/* API 키 설정 패널 (접힘/펼침) */}
                  {showAiKeyConfig && (
                    <div
                      style={{
                        background: "rgba(15, 23, 42, 0.6)",
                        border: "1px solid rgba(148, 163, 184, 0.15)",
                        borderRadius: "8px",
                        padding: "14px 16px",
                        marginBottom: "14px",
                      }}
                    >
                      <div style={{ fontSize: "13px", fontWeight: 600, color: "#f8fafc", marginBottom: "6px" }}>
                        Google Gemini API 키 설정 (Method A)
                      </div>
                      <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "10px", lineHeight: "1.5" }}>
                        Google AI Studio에서 발급받으신 Gemini API 키를 입력하세요. 저장을 누르시면 프로젝트 내{" "}
                        <code style={{ color: "#38bdf8" }}>config/upbit_config.json</code>의{" "}
                        <code style={{ color: "#38bdf8" }}>gemini_api_key</code> 항목에 안전하게 저장됩니다.
                        {aiBriefing?.has_key && (
                          <span style={{ color: "#4ade80", marginLeft: "6px", fontWeight: 600 }}>
                            (현재 등록된 키: {aiBriefing.masked_key})
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: "8px", maxWidth: "600px" }}>
                        <input
                          type="password"
                          placeholder="AIzaSy로 시작하는 Gemini API Key 입력..."
                          value={aiKeyInput}
                          onChange={(e) => setAiKeyInput(e.target.value)}
                          style={{
                            flex: 1,
                            padding: "7px 12px",
                            fontSize: "13px",
                            background: "#0f172a",
                            border: "1px solid rgba(148, 163, 184, 0.3)",
                            borderRadius: "6px",
                            color: "#fff",
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ padding: "7px 16px", fontSize: "13px" }}
                          onClick={handleSaveAiKey}
                        >
                          저장
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: "7px 12px", fontSize: "13px" }}
                          onClick={() => setShowAiKeyConfig(false)}
                        >
                          닫기
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 에러 메시지 알림 */}
                  {aiError && (
                    <div
                      style={{
                        fontSize: "12.5px",
                        color: "#f87171",
                        background: "rgba(239, 68, 68, 0.12)",
                        border: "1px solid rgba(239, 68, 68, 0.3)",
                        borderRadius: "8px",
                        padding: "10px 14px",
                        marginBottom: "14px",
                        lineHeight: "1.5",
                      }}
                    >
                      ⚠️ {aiError}
                    </div>
                  )}

                  {/* Gemini 무료 API 호출 잔여 건수 & 듀얼 AI(Flash 30분 / Pro 1시간) 자동 분석 스케줄 안내 바 */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "8px",
                      fontSize: "12px",
                      color: "#cbd5e1",
                      background: "rgba(15, 23, 42, 0.55)",
                      border: "1px solid rgba(99, 102, 241, 0.25)",
                      borderRadius: "8px",
                      padding: "8px 14px",
                      marginBottom: "14px",
                    }}
                  >
                    <div>
                      📊{" "}
                      <strong style={{ color: "#38bdf8" }}>
                        {geminiQuotaNotice ||
                          `금일 자동 분석 예약(${geminiQuota?.auto_reserved_count ?? 6}건) 제외 남은 무료 API 호출 건수: ${geminiQuota?.remaining_calls ?? 30}건 / ${geminiQuota?.manual_limit ?? 30}건`}
                      </strong>
                    </div>
                    <div style={{ color: "#94a3b8", fontSize: "11.5px" }}>
                      Flash 30분(단기 감지) · Pro 1시간(심층 퀀트) 자동 교차 검증 실행
                      {geminiQuota?.next_scheduled_at ? ` (다음 예약: ${geminiQuota.next_scheduled_at})` : ""}
                    </div>
                  </div>

                  {/* 아직 API 키가 없고 분석 기록도 없을 때의 안내 */}
                  {!aiBriefing?.has_key && !aiBriefing?.latest && !aiLoading && !isStreaming && (
                    <div
                      style={{
                        padding: "20px",
                        textAlign: "center",
                        background: "rgba(15, 23, 42, 0.4)",
                        borderRadius: "8px",
                        border: "1px dashed rgba(99, 102, 241, 0.3)",
                      }}
                    >
                      <div style={{ fontSize: "24px", marginBottom: "8px" }}>💡</div>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#f8fafc", marginBottom: "4px" }}>
                        Gemini API 키를 등록하고 AI 마켓 브리핑을 시작하세요
                      </div>
                      <div style={{ fontSize: "12.5px", color: "#94a3b8", maxWidth: "600px", margin: "0 auto 14px", lineHeight: "1.5" }}>
                        비트코인 일봉 20MA, 4시간 60MA 수급 현황과 3개 자동매매 봇들의 진입/대기 이유를 Gemini 3.5 Flash가 실시간으로 분석해 드립니다.
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ padding: "6px 16px", fontSize: "13px" }}
                        onClick={() => setShowAiKeyConfig(true)}
                      >
                        Gemini API 키 등록하기
                      </button>
                    </div>
                  )}

                  {/* 로딩 인디케이터 (스트리밍 시작 전 연결 단계) */}
                  {aiLoading && (
                    <div
                      style={{
                        padding: "28px 20px",
                        textAlign: "center",
                        background: "rgba(15, 23, 42, 0.4)",
                        borderRadius: "8px",
                      }}
                    >
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#f8fafc", marginBottom: "6px" }}>
                        ⚡ 업비트 실시간 호가 & 봇 지표 취합 및 Gemini 연결 중...
                      </div>
                      <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                        비트코인 이평선 이격도, 변동성 지표, 3개 봇 포지션을 취합하여 맞춤형 스트리밍 브리핑을 준비하고 있습니다.
                      </div>
                    </div>
                  )}

                  {/* 분석 결과 리포트 표시 (스트리밍 작성 중이거나, 완료된 브리핑이 있을 때) */}
                  {(isStreaming || (!aiLoading && aiBriefing?.latest)) && (
                    <div>
                      {/* 주요 지표 요약 바 & 듀얼 AI 교차 검증 매트릭스 */}
                      {(() => {
                        const currentMeta = isStreaming && streamingMeta ? streamingMeta : aiBriefing?.latest;
                        const rf = aiBriefing?.regime_filter || streamingMeta?.regime_filter;
                        if (!currentMeta) return null;
                        return (
                          <div>
                            {/* 1. 기본 시장 지표 요약 바 */}
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: "12px",
                                marginBottom: "10px",
                                padding: "10px 14px",
                                background: "rgba(15, 23, 42, 0.5)",
                                borderRadius: "8px",
                                border: "1px solid rgba(255, 255, 255, 0.05)",
                                alignItems: "center",
                              }}
                            >
                              <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>
                                🪙 <strong style={{ color: "#f8fafc" }}>BTC 현재가:</strong>{" "}
                                {currentMeta.btc_price ? Number(currentMeta.btc_price).toLocaleString("ko-KR") + "원" : "-"}
                              </div>
                              <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>
                                📈 <strong style={{ color: "#f8fafc" }}>일봉 20MA:</strong>{" "}
                                {currentMeta.btc_daily_20ma ? Math.floor(Number(currentMeta.btc_daily_20ma)).toLocaleString("ko-KR") + "원" : "-"}
                              </div>
                              <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>
                                ⏱️ <strong style={{ color: "#f8fafc" }}>4시간 60MA:</strong>{" "}
                                {currentMeta.btc_4h_60ma ? Math.floor(Number(currentMeta.btc_4h_60ma)).toLocaleString("ko-KR") + "원" : "-"}
                              </div>
                              <div style={{ fontSize: "12.5px" }}>
                                {currentMeta.regime_status === "HOLD_CASH" ? (
                                  <span style={{ color: "#f87171", fontWeight: 700 }}>🔴 기술 체제: 신규매수차단 (현금보유)</span>
                                ) : (
                                  <span style={{ color: "#4ade80", fontWeight: 700 }}>🟢 기술 체제: 정상거래 허용 (상승추세)</span>
                                )}
                              </div>
                              {isStreaming && (
                                <div style={{ fontSize: "12px", color: "#38bdf8", marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
                                  <span className="spinner" style={{ width: "12px", height: "12px" }} />
                                  한 자씩 실시간 타이핑 중...
                                </div>
                              )}
                            </div>

                            {/* 2. 듀얼 AI 엔진 (30분 Flash & 1시간 Pro) 교차 검증 매트릭스 카드 */}
                            {rf && (
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                                  gap: "10px",
                                  marginBottom: "14px",
                                  padding: "12px 14px",
                                  background: "linear-gradient(135deg, rgba(30, 27, 75, 0.45) 0%, rgba(15, 23, 42, 0.7) 100%)",
                                  borderRadius: "8px",
                                  border: "1px solid rgba(99, 102, 241, 0.28)",
                                }}
                              >
                                {/* Flash 30분 단기 분석 */}
                                <div style={{ padding: "8px 12px", background: "rgba(15, 23, 42, 0.6)", borderRadius: "6px", border: "1px solid rgba(56, 189, 248, 0.25)" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                                    <span style={{ fontSize: "12px", fontWeight: 700, color: "#38bdf8" }}>⚡ Gemini Flash (30분 단기)</span>
                                    <span
                                      style={{
                                        fontSize: "11px",
                                        fontWeight: 700,
                                        padding: "2px 7px",
                                        borderRadius: "4px",
                                        background: rf.flash_recommended_action === "NORMAL" ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)",
                                        color: rf.flash_recommended_action === "NORMAL" ? "#4ade80" : "#f87171",
                                        border: `1px solid ${rf.flash_recommended_action === "NORMAL" ? "rgba(34, 197, 94, 0.4)" : "rgba(239, 68, 68, 0.4)"}`,
                                      }}
                                    >
                                      {rf.flash_recommended_action || "NORMAL"}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: "11.5px", color: "#cbd5e1" }}>
                                    단기 투심 점수:{" "}
                                    <strong style={{ color: (Number(rf.flash_sentiment_score) || 0) >= 0 ? "#4ade80" : "#f87171" }}>
                                      {(Number(rf.flash_sentiment_score) || 0) > 0 ? "+" : ""}{(Number(rf.flash_sentiment_score) || 0).toFixed(2)}
                                    </strong>
                                  </div>
                                  <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "3px" }}>
                                    최근 갱신: {formatDateTimeKST(rf.flash_updated_at)}
                                  </div>
                                </div>

                                {/* Pro 1시간 심층 퀀트 분석 */}
                                <div style={{ padding: "8px 12px", background: "rgba(15, 23, 42, 0.6)", borderRadius: "6px", border: "1px solid rgba(168, 85, 247, 0.25)" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                                    <span style={{ fontSize: "12px", fontWeight: 700, color: "#c084fc" }}>🧠 Gemini Pro (1시간 심층)</span>
                                    <span
                                      style={{
                                        fontSize: "11px",
                                        fontWeight: 700,
                                        padding: "2px 7px",
                                        borderRadius: "4px",
                                        background: rf.pro_recommended_action === "NORMAL" ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)",
                                        color: rf.pro_recommended_action === "NORMAL" ? "#4ade80" : "#f87171",
                                        border: `1px solid ${rf.pro_recommended_action === "NORMAL" ? "rgba(34, 197, 94, 0.4)" : "rgba(239, 68, 68, 0.4)"}`,
                                      }}
                                    >
                                      {rf.pro_recommended_action || "NORMAL"}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: "11.5px", color: "#cbd5e1" }}>
                                    거시 체제 점수:{" "}
                                    <strong style={{ color: (Number(rf.pro_sentiment_score) || 0) >= 0 ? "#4ade80" : "#f87171" }}>
                                      {(Number(rf.pro_sentiment_score) || 0) > 0 ? "+" : ""}{(Number(rf.pro_sentiment_score) || 0).toFixed(2)}
                                    </strong>
                                  </div>
                                  <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "3px" }}>
                                    최근 갱신: {formatDateTimeKST(rf.pro_updated_at)}
                                  </div>
                                </div>

                                {/* 교차 검증 최종 종합 판정 */}
                                <div style={{ padding: "8px 12px", background: "rgba(15, 23, 42, 0.6)", borderRadius: "6px", border: "1px solid rgba(99, 102, 241, 0.35)" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                                    <span style={{ fontSize: "12px", fontWeight: 700, color: "#a5b4fc" }}>🛡️ 다중 모델 교차검증 결론</span>
                                    <span
                                      style={{
                                        fontSize: "11px",
                                        fontWeight: 700,
                                        padding: "2px 7px",
                                        borderRadius: "4px",
                                        background:
                                          rf.final_risk_alert || Number(rf.final_position_multiplier) === 0
                                            ? "rgba(239, 68, 68, 0.2)"
                                            : Number(rf.final_position_multiplier) <= 0.5
                                            ? "rgba(234, 179, 8, 0.2)"
                                            : "rgba(34, 197, 94, 0.2)",
                                        color:
                                          rf.final_risk_alert || Number(rf.final_position_multiplier) === 0
                                            ? "#f87171"
                                            : Number(rf.final_position_multiplier) <= 0.5
                                            ? "#facc15"
                                            : "#4ade80",
                                        border: `1px solid ${
                                          rf.final_risk_alert || Number(rf.final_position_multiplier) === 0
                                            ? "rgba(239, 68, 68, 0.4)"
                                            : Number(rf.final_position_multiplier) <= 0.5
                                            ? "rgba(234, 179, 8, 0.4)"
                                            : "rgba(34, 197, 94, 0.4)"
                                        }`,
                                      }}
                                    >
                                      {rf.final_risk_alert || Number(rf.final_position_multiplier) === 0
                                        ? "신규 매수 전면 차단"
                                        : Number(rf.final_position_multiplier) <= 0.5
                                        ? `비중 ${(Number(rf.final_position_multiplier) * 100).toFixed(0)}% 축소 운용`
                                        : "100% 정상 진입 허용"}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: "11px", color: "#cbd5e1", lineHeight: "1.4" }} title={rf.reason || ""}>
                                    {rf.reason ? (rf.reason.length > 60 ? rf.reason.slice(0, 60) + "..." : rf.reason) : "보수적 리스크 우선 원칙 및 단기 쇼크 방어 적용"}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* 마크다운 텍스트 뷰어 */}
                      <div
                        style={{
                          background: "rgba(15, 23, 42, 0.4)",
                          borderRadius: "8px",
                          padding: "16px 20px",
                          border: "1px solid rgba(255, 255, 255, 0.04)",
                        }}
                      >
                        <MarkdownViewer
                          content={isStreaming ? streamingText : aiBriefing?.latest?.briefing_text}
                          isStreaming={isStreaming}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 실전 담당 봇 탭 구분 (선택된 1~3개 실전 봇만 동적 노출) */}
            {(() => {
              const matched = bots.filter((b) => Number(b.is_selected_for_live) === 1 || selectedLiveBotIds.includes(b.bot_id));
              const liveBots = matched.length > 0 ? matched : bots.slice(0, 3);
              if (liveBots.length === 0) {
                return (
                  <div
                    className="card"
                    style={{
                      padding: "16px 20px",
                      marginBottom: "16px",
                      background: "rgba(239, 68, 68, 0.1)",
                      border: "1px dashed rgba(239, 68, 68, 0.4)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "10px",
                    }}
                  >
                    <div>
                      <strong style={{ color: "#fca5a5" }}>⚡ 현재 실제 거래를 담당하는 실전 봇이 선택되지 않았습니다.</strong>
                      <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "3px" }}>
                        설정 화면에서 실제 거래를 담당할 봇(1~3개)을 선택하고 운용 원금을 배분해주세요.
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => handleMenuChange("settings")}
                      style={{ padding: "8px 14px", fontSize: "12.5px" }}
                    >
                      ⚙️ 설정으로 이동하여 실전 봇 선택하기
                    </button>
                  </div>
                );
              }

              return (
                <div className="tab-bar">
                  {liveBots.map((bot) => (
                    <button
                      key={bot.bot_id}
                      className={`tab-btn ${selectedBotId === bot.bot_id ? "active" : ""}`}
                      onClick={() => {
                        setSelectedBotId(bot.bot_id);
                        fetchTrades(bot.bot_id, "live");
                      }}
                    >
                      <span
                        className={`status-dot ${bot.is_running ? "green" : "red"}`}
                        style={{ width: "8px", height: "8px" }}
                      />
                      <span>{bot.nickname || bot.name}</span>
                      <span
                        style={{
                          fontSize: "10.5px",
                          marginLeft: "6px",
                          padding: "1px 6px",
                          borderRadius: "8px",
                          background: "rgba(239, 68, 68, 0.25)",
                          color: "#fca5a5",
                          fontWeight: 700,
                        }}
                      >
                        실전 {bot.allocation_ratio}%
                      </span>
                      {bot.circuit_breaker_active && (
                        <span
                          style={{
                            fontSize: "10px",
                            marginLeft: "4px",
                            padding: "1px 5px",
                            borderRadius: "4px",
                            background: "rgba(239, 68, 68, 0.35)",
                            color: "#fca5a5",
                            fontWeight: 700,
                          }}
                          title="일일 손실 방어 서킷 브레이커 발동 (-4.0% 도달, 자정까지 신규 매수 차단)"
                        >
                          ⚡ 서킷차단
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              );
            })()}

            {/* 선택된 봇 상태 및 거래시작 / 중단 버튼 (요구사항 20) */}
            {currentBot && (
              <div className="card">
                <div className="bot-control-panel">
                  <div>
                    <div style={{ fontSize: "18px", fontWeight: 800, marginBottom: "6px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <span>{currentBot.nickname || currentBot.name}</span>
                      <span style={{ fontSize: "13px", color: "#94a3b8", fontWeight: 500 }}>
                        ({currentBot.name})
                      </span>
                      {currentBot.circuit_breaker_active && (
                        <span
                          style={{
                            fontSize: "11px",
                            padding: "2px 8px",
                            borderRadius: "6px",
                            background: "rgba(239, 68, 68, 0.2)",
                            border: "1px solid rgba(239, 68, 68, 0.5)",
                            color: "#f87171",
                            fontWeight: 700,
                          }}
                        >
                          ⚡ 일일 서킷 브레이커 발동 (신규 매수 차단)
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "13px", color: "#94a3b8", marginBottom: "14px" }}>
                      {currentBot.description}
                    </div>
                    <div className="bot-meta-grid">
                      <div className="meta-item">
                        <span className="meta-label">동작 상태</span>
                        <span
                          className="meta-value"
                          style={{ color: currentBot.is_running ? "#22c55e" : "#f87171" }}
                        >
                          {currentBot.is_running ? "● 거래 진행 중" : "■ 거래 중지됨"}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">할당 원금 (분배비율 {currentBot.allocation_ratio}%)</span>
                        <span className="meta-value">{formatKRW(currentBot.allocated_capital)}</span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">가용 가상잔고 (virtual_krw)</span>
                        <span className="meta-value" style={{ color: "#a5b4fc" }}>
                          {formatKRW(currentBot.virtual_krw)}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">일일 손익 / 서킷 브레이커 한도 (-4.0%)</span>
                        <span
                          className="meta-value"
                          style={{
                            color: currentBot.circuit_breaker_active
                              ? "#ef4444"
                              : (Number(currentBot.daily_profit_krw || 0) >= 0 ? "#22c55e" : "#fca5a5"),
                            fontWeight: 700,
                          }}
                        >
                          {formatKRW(currentBot.daily_profit_krw || 0)}
                          <span style={{ fontSize: "11.5px", color: "#94a3b8", marginLeft: "6px", fontWeight: 500 }}>
                            (한도: -{formatKRW(currentBot.daily_loss_limit_krw || Math.floor((currentBot.allocated_capital || 0) * 0.04))})
                          </span>
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">최소 거래대금 필터</span>
                        <span className="meta-value">{formatKRW(currentBot.min_volume_krw)}</span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">현재 봇 상태 메시지</span>
                        <span className="meta-value" style={{ fontSize: "13.5px", color: "#cbd5e1" }}>
                          {currentBot.last_status_msg}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="btn-group">
                    <button
                      className="btn btn-start"
                      onClick={() => handleBotStartStop(currentBot.bot_id, true)}
                      disabled={
                        Boolean(currentBot.is_running) ||
                        Number(currentBot.allocated_capital || 0) <= 0
                      }
                      title={
                        Number(currentBot.allocated_capital || 0) <= 0
                          ? "할당 원금이 0원이므로 거래를 시작할 수 없습니다. 설정 메뉴에서 자금 분배 비율을 설정해주세요."
                          : ""
                      }
                    >
                      ▶ 거래시작
                    </button>
                    <button
                      className="btn btn-stop"
                      onClick={() => handleBotStartStop(currentBot.bot_id, false)}
                      disabled={!currentBot.is_running}
                    >
                      ■ 거래중단
                    </button>
                    <button
                      className="btn btn-outline"
                      onClick={() => handleManualTradeTest(currentBot.bot_id, "buy")}
                      title="실제 주문이나 거래 이력을 남기지 않고 해당 봇의 가용 잔고 기준 매수 가능 여부만 확인합니다"
                    >
                      + 매수 테스트 (단순 확인)
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 요구사항 9: 게시판 형식 거래정보 (매수, 매도, 매수일, 매도일, 차익 한 줄 표기 / 미매도 시 빈칸, 매도 시 업데이트) */}
            <div className="card">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "14px",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <h3 style={{ fontSize: "16px", fontWeight: 700 }}>
                  거래 내역 게시판 ({currentBot?.nickname})
                </h3>
                <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                  * 매도를 하지 않은 포지션은 매도/매도일/차익 칸이 빈칸으로 유지되며, 매도 완료 시 해당 줄(Row)이 자동 업데이트됩니다.
                </span>
              </div>

              <div className="table-container">
                <table className="board-table">
                  <thead>
                    <tr>
                      <th>번호</th>
                      <th>코인(마켓)</th>
                      <th>매수 (금액 / 단가 / 수량)</th>
                      <th>매도 (금액 / 단가 / 수량)</th>
                      <th>매수일</th>
                      <th>매도일</th>
                      <th>차익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: "center", padding: "32px", color: "#94a3b8" }}>
                          해당 봇의 거래 내역이 없습니다.
                        </td>
                      </tr>
                    ) : (
                      trades.map((t, index) => {
                        const isSold = t.status === "COMPLETED" && t.sell_amount !== null;
                        return (
                          <tr key={t.id}>
                            <td>{trades.length - index}</td>
                            <td style={{ fontWeight: 700 }}>{t.market}</td>
                            <td>
                              <div style={{ fontWeight: 700 }}>{formatKRW(t.buy_amount)}</div>
                              <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                                단가 {Number(t.buy_price).toLocaleString()}원 | 수량 {t.buy_volume}
                              </div>
                            </td>
                            {/* 매도하지 않았다면 빈칸(""), 매도했다면 업데이트된 값 표시 */}
                            <td>
                              {isSold ? (
                                <>
                                  <div style={{ fontWeight: 700 }}>{formatKRW(t.sell_amount)}</div>
                                  <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                                    단가 {Number(t.sell_price).toLocaleString()}원 | 수량 {t.sell_volume}
                                  </div>
                                </>
                              ) : (
                                ""
                              )}
                            </td>
                            <td>{t.buy_date}</td>
                            <td>{isSold ? t.sell_date : ""}</td>
                            <td>
                              {isSold ? (
                                <div>
                                  {renderColoredProfit(t.profit_krw)}{" "}
                                  <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                                    ({t.profit_pct > 0 ? `+${t.profit_pct}` : t.profit_pct}%)
                                  </span>
                                </div>
                              ) : (
                                ""
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================
            [메뉴 2] 통계 (요구사항 10, 11, 12)
           ============================================================ */}
        {activeMenu === "stats" && (
          <div>
            <div className="page-header">
              <div>
                <h2 className="page-title">📈 통계</h2>
                <p className="page-desc">
                  통계 시작일({stats.start_date || "2026.10.01"}) 기준 차익 선 그래프 및 다빈도 거래 코인 / 봇별 누적 실현손익입니다.
                </p>
              </div>

              {/* 통계 모드 탭 (실제거래 통계 ↔ 가상거래 10대 봇 통계) */}
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "10px" }}>
                <button
                  type="button"
                  className={`btn ${statsModeTab === "live" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => {
                    setStatsModeTab("live");
                    fetchStatistics("live");
                    fetchStatsTrades(1, statsTradeFilterBot, "live");
                  }}
                  style={{ padding: "8px 14px", fontSize: "12.5px" }}
                >
                  ⚡ 실제거래 통계
                </button>
                <button
                  type="button"
                  className={`btn ${statsModeTab === "paper" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => {
                    setStatsModeTab("paper");
                    fetchStatistics("paper");
                    fetchStatsTrades(1, statsTradeFilterBot, "paper");
                  }}
                  style={{ padding: "8px 14px", fontSize: "12.5px" }}
                >
                  🏆 가상거래 10대 봇 통계
                </button>
              </div>
            </div>

            {/* 통계 모드 안내 배너 */}
            <div
              className="card"
              style={{
                marginBottom: "16px",
                padding: "12px 18px",
                background:
                  statsModeTab === "live"
                    ? "linear-gradient(135deg, rgba(239, 68, 68, 0.12) 0%, rgba(69, 10, 10, 0.25) 100%)"
                    : "linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(6, 78, 59, 0.25) 100%)",
                borderColor: statsModeTab === "live" ? "rgba(239, 68, 68, 0.45)" : "rgba(16, 185, 129, 0.45)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ fontSize: "20px" }}>{statsModeTab === "live" ? "⚡" : "🏆"}</span>
                <div>
                  <strong style={{ color: statsModeTab === "live" ? "#fca5a5" : "#6ee7b7" }}>
                    {statsModeTab === "live" ? "현재 [실제거래(Live)] 통계 집계 중" : "현재 [가상거래 10대 봇(Arena)] 통계 집계 중"}
                  </strong>
                  <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}>
                    {statsModeTab === "live"
                      ? "업비트 실거래 원장(trades)의 체결 내역을 바탕으로 산출된 실계좌 통계입니다."
                      : "가상거래 전용 원장(paper_trades)에 기록된 10대 알고리즘 모의 체결 통계입니다."}
                  </div>
                </div>
              </div>
            </div>

            {/* ============================================================
                [요구사항] 실전 수익 통계 상단: 이번달 1일 시점 평가자산, 현재 시점 평가자산, 금액 증감 및 월별 보유 자산 증감 그래프
               ============================================================ */}
            <div
              className="card"
              style={{
                marginBottom: "20px",
                border: "1px solid rgba(56, 189, 248, 0.35)",
                background: "linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.85))",
                boxShadow: "0 10px 30px -10px rgba(0, 0, 0, 0.6)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "10px",
                  marginBottom: "16px",
                  borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
                  paddingBottom: "12px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ fontSize: "22px" }}>💰</span>
                  <div>
                    <h3 style={{ margin: 0, fontSize: "17px", fontWeight: "800", color: "#f8fafc" }}>
                      {statsModeTab === "live" ? "실전 실계좌 자산 평가 및 월간 증감 현황" : "가상거래(10대 봇) 자산 평가 및 월간 증감 현황"}
                    </h3>
                    <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}>
                      매달 1일 시점의 평가자산을 자동으로 기록하고, 현재 평가자산과 비교하여 자산 증감(수익/손실)을 실시간 추적합니다.
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "11.5px", color: "#94a3b8" }}>
                    최근 기록: {stats?.monthly_assets?.updated_at || "-"}
                  </span>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => fetchStatistics(statsModeTab)}
                    style={{ padding: "4px 10px", fontSize: "12px" }}
                    title="자산 스냅샷 및 통계를 새로고침합니다"
                  >
                    🔄 새로고침
                  </button>
                </div>
              </div>

              {/* 3대 핵심 자산 지표 카드 그리드 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "12px",
                  marginBottom: "20px",
                }}
              >
                {/* 1) 이번달 1일 시점의 평가자산 */}
                <div
                  style={{
                    background: "rgba(15, 23, 42, 0.7)",
                    border: "1px solid rgba(255, 255, 255, 0.08)",
                    borderRadius: "12px",
                    padding: "16px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "12.5px",
                      color: "#94a3b8",
                      marginBottom: "6px",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <span>📅</span>
                    <span>이번달 1일 시점 평가자산</span>
                  </div>
                  <div style={{ fontSize: "22px", fontWeight: "800", color: "#e2e8f0" }}>
                    {stats?.monthly_assets?.current_month?.month_start_balance !== undefined
                      ? `${Math.floor(stats.monthly_assets.current_month.month_start_balance).toLocaleString("ko-KR")}원`
                      : statsModeTab === "live" && upbitAccount?.total_asset_krw !== null
                      ? `${Math.floor(Number(upbitAccount.total_asset_krw)).toLocaleString("ko-KR")}원`
                      : "-"}
                  </div>
                  <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "6px" }}>
                    기준 시점: {stats?.monthly_assets?.current_month?.snapshot_date || "매월 1일 00:00 KST"}
                  </div>
                </div>

                {/* 2) 현재 시점의 평가자산 */}
                <div
                  style={{
                    background: "rgba(15, 23, 42, 0.7)",
                    border: "1px solid rgba(56, 189, 248, 0.35)",
                    borderRadius: "12px",
                    padding: "16px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "12.5px",
                      color: "#38bdf8",
                      marginBottom: "6px",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <span>⚡</span>
                    <span style={{ fontWeight: "700" }}>현재 시점 평가자산</span>
                  </div>
                  <div style={{ fontSize: "22px", fontWeight: "800", color: "#38bdf8" }}>
                    {stats?.monthly_assets?.current_month?.current_balance !== undefined
                      ? `${Math.floor(stats.monthly_assets.current_month.current_balance).toLocaleString("ko-KR")}원`
                      : statsModeTab === "live" && upbitAccount?.total_asset_krw !== null
                      ? `${Math.floor(Number(upbitAccount.total_asset_krw)).toLocaleString("ko-KR")}원`
                      : "-"}
                  </div>
                  <div style={{ fontSize: "11.5px", color: "#94a3b8", marginTop: "6px" }}>
                    {statsModeTab === "live"
                      ? `원화 ${Math.floor(Number(stats?.monthly_assets?.current_month?.krw_balance ?? upbitAccount?.krw_total ?? upbitAccount?.krw_balance ?? 0)).toLocaleString("ko-KR")}원 · 코인평가 ${Math.floor(Number(stats?.monthly_assets?.current_month?.coin_eval_balance ?? upbitAccount?.total_eval_krw ?? 0)).toLocaleString("ko-KR")}원`
                      : `가상현금 ${Math.floor(Number(stats?.monthly_assets?.current_month?.krw_balance ?? 0)).toLocaleString("ko-KR")}원 · 보유평가 ${Math.floor(Number(stats?.monthly_assets?.current_month?.coin_eval_balance ?? 0)).toLocaleString("ko-KR")}원`}
                  </div>
                </div>

                {/* 3) 금액 증감 현황 (늘었는지 줄었는지 표기) */}
                {(() => {
                  const cur = stats?.monthly_assets?.current_month;
                  const diffAmt = cur ? Number(cur.diff_amount || 0) : 0;
                  const diffRate = cur ? Number(cur.diff_rate || 0) : 0;
                  const isInc = diffAmt > 0;
                  const isDec = diffAmt < 0;
                  const statusBg = isInc
                    ? "rgba(34, 197, 94, 0.12)"
                    : isDec
                    ? "rgba(239, 68, 68, 0.12)"
                    : "rgba(148, 163, 184, 0.12)";
                  const statusBorder = isInc
                    ? "rgba(34, 197, 94, 0.4)"
                    : isDec
                    ? "rgba(239, 68, 68, 0.4)"
                    : "rgba(148, 163, 184, 0.25)";
                  const statusColor = isInc ? "#4ade80" : isDec ? "#f87171" : "#cbd5e1";

                  return (
                    <div
                      style={{
                        background: statusBg,
                        border: `1px solid ${statusBorder}`,
                        borderRadius: "12px",
                        padding: "16px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "6px",
                        }}
                      >
                        <span style={{ fontSize: "12.5px", color: "#94a3b8" }}>월간 자산 증감</span>
                        <span
                          style={{
                            padding: "3px 9px",
                            borderRadius: "6px",
                            fontSize: "11px",
                            fontWeight: "800",
                            background: statusColor,
                            color: "#0f172a",
                          }}
                        >
                          {isInc ? "▲ 금액 증가 (수익)" : isDec ? "▼ 금액 감소 (손실)" : "- 변동 없음 (보합)"}
                        </span>
                      </div>
                      <div style={{ fontSize: "22px", fontWeight: "800", color: statusColor }}>
                        {isInc ? "+" : ""}
                        {Math.floor(diffAmt).toLocaleString("ko-KR")}원
                      </div>
                      <div style={{ fontSize: "12px", fontWeight: "700", color: statusColor, marginTop: "6px" }}>
                        1일 대비 {isInc ? "▲ +" : isDec ? "▼ " : ""}{diffRate.toFixed(2)}% {isInc ? "증가" : isDec ? "감소" : "유지"}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* 월별 보유 자산 증감 그래프 섹션 */}
              <div style={{ borderTop: "1px solid rgba(255, 255, 255, 0.08)", paddingTop: "20px", marginTop: "4px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "12px",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <h4 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "#f8fafc" }}>
                    📊 월별 보유 자산 및 증감 추이 그래프 (Monthly Growth Chart)
                  </h4>
                  <span style={{ fontSize: "11.5px", color: "#94a3b8" }}>
                    * 매월 1일 자산 대비 현재/말일 자산의 증감을 비교합니다.
                  </span>
                </div>

                <MonthlyAssetGrowthChart
                  history={stats?.monthly_assets?.history || []}
                  currentMonth={stats?.monthly_assets?.current_month}
                  onRefresh={() => fetchStatistics(statsModeTab)}
                  loading={false}
                />
              </div>
            </div>

            {/* 일간 / 주간 / 월간 탭 */}
            <div className="tab-bar">
              <button
                className={`tab-btn ${statsPeriodTab === "daily" ? "active" : ""}`}
                onClick={() => setStatsPeriodTab("daily")}
              >
                일간 (Daily)
              </button>
              <button
                className={`tab-btn ${statsPeriodTab === "weekly" ? "active" : ""}`}
                onClick={() => setStatsPeriodTab("weekly")}
              >
                주간 (Weekly)
              </button>
              <button
                className={`tab-btn ${statsPeriodTab === "monthly" ? "active" : ""}`}
                onClick={() => setStatsPeriodTab("monthly")}
              >
                월간 (Monthly)
              </button>
            </div>

            {/* 차익 추이 선 그래프 */}
            <div className="card">
              <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "14px" }}>
                {periodLabel} 차익 추이 선 그래프 (시작일: 2026.10.01)
              </h3>
              <ProfitLineChart series={chartSeries} periodLabel={periodLabel} />
            </div>

            {/* 코인별 누적 손익 순위 게시판 */}
            <div className="card" style={{ marginBottom: "20px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "14px",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0 }}>
                  다빈도 거래 코인 순위 및 기간별 누적 손익
                </h3>
                <div style={{ fontSize: "12px", display: "flex", gap: "12px" }}>
                  <span className="pnl-profit">● 이익: 빨간색</span>
                  <span className="pnl-loss">● 손해: 파란색</span>
                  <span className="pnl-Zero">● 그 외(0원): 검은색/회색</span>
                </div>
              </div>

              <div className="table-container">
                <table className="board-table">
                  <thead>
                    <tr>
                      <th style={{ width: "60px" }}>순위</th>
                      <th>코인(마켓)</th>
                      <th>총 거래 횟수</th>
                      <th>주간 누적 손익</th>
                      <th>월간 누적 손익</th>
                      <th>연간 누적 손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!stats.coin_ranking || stats.coin_ranking.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: "28px", color: "#94a3b8" }}>
                          집계된 코인 거래 통계가 없습니다.
                        </td>
                      </tr>
                    ) : (
                      stats.coin_ranking.map((coin, idx) => (
                        <tr key={coin.market}>
                          <td style={{ fontWeight: 700 }}>{idx + 1}위</td>
                          <td style={{ fontWeight: 700 }}>{coin.market}</td>
                          <td>
                            {coin.trade_count}회{" "}
                            <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                              (완료 {coin.completed_count} / 보유 {coin.holding_count})
                            </span>
                          </td>
                          <td>{renderColoredProfit(coin.weekly_profit)}</td>
                          <td>{renderColoredProfit(coin.monthly_profit)}</td>
                          <td>{renderColoredProfit(coin.yearly_profit)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 봇별 실현손익 기여도 순위 (신규 추가) */}
            {Array.isArray(stats.bot_ranking) && stats.bot_ranking.length > 0 && (
              <div className="card">
                <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "14px" }}>
                  봇별 실현손익 기여도 및 승률 순위
                </h3>
                <div className="table-container">
                  <table className="board-table">
                    <thead>
                      <tr>
                        <th style={{ width: "60px" }}>순위</th>
                        <th>알고리즘 봇</th>
                        <th>총 체결 수</th>
                        <th>승리 / 패배</th>
                        <th>승률</th>
                        <th>총 실현 손익</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.bot_ranking.map((b, idx) => (
                        <tr key={b.bot_id}>
                          <td style={{ fontWeight: 700 }}>{idx + 1}위</td>
                          <td style={{ fontWeight: 700, color: "#f8fafc" }}>
                            {b.nickname || b.bot_id}
                          </td>
                          <td>{b.completed_count}건</td>
                          <td>
                            {b.win_count}승 {b.lose_count}패
                          </td>
                          <td style={{ fontWeight: 700 }}>{b.win_rate_pct}%</td>
                          <td>{renderColoredProfit(b.total_profit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ============================================================
                [통계 최하단] 거래 내역 및 50건 페이징 게시판 (실거래 / 가상거래 자동 연동)
               ============================================================ */}
            <div className="card" style={{ marginTop: "20px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "16px",
                  flexWrap: "wrap",
                  gap: "12px",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                      {statsModeTab === "live" ? "⚡ 실제 거래 내역 (Live Trade History)" : "🏆 가상 거래 내역 (Arena Trade History)"}
                    </h3>
                    <span
                      style={{
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        background: statsModeTab === "live" ? "rgba(239, 68, 68, 0.2)" : "rgba(16, 185, 129, 0.2)",
                        color: statsModeTab === "live" ? "#fca5a5" : "#6ee7b7",
                        border: `1px solid ${statsModeTab === "live" ? "rgba(239, 68, 68, 0.4)" : "rgba(16, 185, 129, 0.4)"}`,
                        fontWeight: 700,
                      }}
                    >
                      {statsModeTab === "live" ? "실계좌 체결 전용 · 50건 페이징" : "10대 봇 아레나 체결 전용 · 50건 페이징"}
                    </span>
                  </div>
                  <p style={{ fontSize: "12.5px", color: "#94a3b8", marginTop: "4px", margin: "4px 0 0 0" }}>
                    {statsModeTab === "live"
                      ? "업비트 실계좌로 체결된 실제 거래 내역(trades)을 페이지당 50건씩 최신순으로 제공합니다."
                      : "10대 봇 아레나 가상 경쟁 체결 내역(paper_trades)을 페이지당 50건씩 최신순으로 제공합니다."}
                  </p>
                </div>

                {/* 필터 및 컨트롤 바 */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  {/* 원장 건수 표시 배지 */}
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "5px 12px",
                      borderRadius: "6px",
                      background: statsModeTab === "live" ? "rgba(239, 68, 68, 0.15)" : "rgba(16, 185, 129, 0.15)",
                      border: `1px solid ${statsModeTab === "live" ? "rgba(239, 68, 68, 0.35)" : "rgba(16, 185, 129, 0.35)"}`,
                      fontSize: "12px",
                      fontWeight: 600,
                      color: statsModeTab === "live" ? "#fca5a5" : "#6ee7b7",
                    }}
                  >
                    <span>{statsModeTab === "live" ? "⚡ 실계좌 원장(trades)" : "🏆 가상 원장(paper_trades)"}</span>
                    <span style={{ color: "#ffffff", fontWeight: 700 }}>({statsTradeTotal}건)</span>
                  </div>

                  {/* 봇 필터 선택 */}
                  <select
                    className="form-input"
                    value={statsTradeFilterBot}
                    onChange={(e) => {
                      const newBot = e.target.value;
                      setStatsTradeFilterBot(newBot);
                      fetchStatsTrades(1, newBot);
                    }}
                    style={{
                      width: "auto",
                      padding: "6px 12px",
                      fontSize: "12px",
                      background: "#0f172a",
                      borderColor: "#334155",
                      color: "#f1f5f9",
                    }}
                  >
                    <option value="all">🤖 전체 실전 봇</option>
                    {bots.map((b) => (
                      <option key={b.bot_id} value={b.bot_id}>
                        {b.nickname || b.name}
                      </option>
                    ))}
                  </select>

                  {/* 새로고침 버튼 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={statsTradeLoading}
                    onClick={() => fetchStatsTrades(statsTradePage, statsTradeFilterBot)}
                    style={{ padding: "6px 12px", fontSize: "12px" }}
                    title="실제 거래내역 새로고침"
                  >
                    {statsTradeLoading ? "조회 중..." : "🔄 새로고침"}
                  </button>
                </div>
              </div>

              {/* 건수 요약 표시 줄 */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "12.5px",
                  color: "#94a3b8",
                  padding: "8px 14px",
                  background: "rgba(15, 23, 42, 0.4)",
                  borderRadius: "6px",
                  marginBottom: "12px",
                  border: "1px solid rgba(255, 255, 255, 0.05)",
                }}
              >
                <div>
                  총 <strong style={{ color: "#f8fafc" }}>{statsTradeTotal.toLocaleString()}</strong>건 중{" "}
                  {statsTradeTotal > 0 ? (
                    <span style={{ color: "#38bdf8" }}>
                      {(statsTradePage - 1) * statsTradeLimit + 1} ~ {Math.min(statsTradePage * statsTradeLimit, statsTradeTotal)}건
                    </span>
                  ) : (
                    "0건"
                  )}{" "}
                  표시 (페이지 {statsTradePage} / {statsTradeTotalPages})
                </div>
                <div>
                  <span style={{ color: "#e2e8f0" }}>한 페이지당 50건 표시</span>
                </div>
              </div>

              {/* 실제 거래내역 테이블 */}
              <div className="table-container">
                <table className="board-table">
                  <thead>
                    <tr>
                      <th style={{ width: "55px", textAlign: "center" }}>번호</th>
                      <th style={{ width: "140px" }}>실전 담당 봇</th>
                      <th style={{ width: "100px" }}>마켓</th>
                      <th>매수 정보 (금액 / 단가 / 수량 / 일시)</th>
                      <th>매도 정보 (금액 / 단가 / 수량 / 일시)</th>
                      <th>실현손익</th>
                      <th style={{ width: "80px", textAlign: "center" }}>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statsTradeLoading && statsTrades.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: "center", padding: "36px", color: "#94a3b8" }}>
                          거래 내역을 불러오는 중입니다...
                        </td>
                      </tr>
                    ) : statsTrades.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: "center", padding: "36px", color: "#94a3b8" }}>
                          {statsModeTab === "live" ? "체결된 실제 거래 내역이 없습니다." : "체결된 가상 거래 내역이 없습니다."}
                        </td>
                      </tr>
                    ) : (
                      statsTrades.map((t, idx) => {
                        const rowNum = (statsTradePage - 1) * statsTradeLimit + idx + 1;
                        const isSold = t.status === "COMPLETED" && t.sell_amount !== null;

                        return (
                          <tr key={`live-trade-${t.id}-${idx}`}>
                            <td style={{ textAlign: "center", color: "#94a3b8", fontSize: "12px" }}>
                              {rowNum}
                            </td>
                            <td>
                              <div style={{ fontWeight: 700, color: "#f8fafc", fontSize: "13px" }}>
                                {t.bot_nickname || t.nickname || t.bot_id}
                              </div>
                              <div style={{ fontSize: "11px", color: "#64748b" }}>
                                {t.bot_name || t.bot_id}
                              </div>
                            </td>
                            <td style={{ fontWeight: 700, color: "#e2e8f0" }}>{t.market}</td>
                            <td>
                              <div style={{ fontWeight: 700, color: "#f1f5f9" }}>{formatKRW(t.buy_amount)}</div>
                              <div style={{ fontSize: "11.5px", color: "#94a3b8", marginTop: "2px" }}>
                                {Number(t.buy_price || 0).toLocaleString()}원 | 수량 {t.buy_volume}
                              </div>
                              <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                                {String(t.buy_date || "").slice(0, 19).replace("T", " ")}
                              </div>
                            </td>
                            <td>
                              {isSold ? (
                                <>
                                  <div style={{ fontWeight: 700, color: "#f1f5f9" }}>{formatKRW(t.sell_amount)}</div>
                                  <div style={{ fontSize: "11.5px", color: "#94a3b8", marginTop: "2px" }}>
                                    {Number(t.sell_price || 0).toLocaleString()}원 | 수량 {t.sell_volume}
                                  </div>
                                  <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                                    {String(t.sell_date || "").slice(0, 19).replace("T", " ")}
                                  </div>
                                </>
                              ) : (
                                <span style={{ color: "#38bdf8", fontSize: "12px", fontWeight: 600 }}>
                                  ● 보유 중 (미매도)
                                </span>
                              )}
                            </td>
                            <td>
                              {isSold && t.profit_krw !== null ? (
                                <div>
                                  <div style={{ fontWeight: 700 }}>
                                    {renderColoredProfit(t.profit_krw)}
                                  </div>
                                  <div style={{ fontSize: "11.5px", marginTop: "2px" }}>
                                    <span
                                      className={
                                        Number(t.profit_pct) > 0
                                          ? "pnl-profit"
                                          : Number(t.profit_pct) < 0
                                          ? "pnl-loss"
                                          : "pnl-zero"
                                      }
                                      style={{ fontWeight: 600 }}
                                    >
                                      {Number(t.profit_pct) > 0 ? `+${t.profit_pct}` : t.profit_pct}%
                                    </span>
                                  </div>
                                </div>
                              ) : (
                                <span style={{ color: "#64748b" }}>-</span>
                              )}
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <span
                                style={{
                                  fontSize: "11px",
                                  padding: "2px 7px",
                                  borderRadius: "6px",
                                  fontWeight: 600,
                                  background:
                                    t.status === "COMPLETED"
                                      ? "rgba(34, 197, 94, 0.15)"
                                      : "rgba(234, 179, 8, 0.15)",
                                  color:
                                    t.status === "COMPLETED" ? "#4ade80" : "#facc15",
                                }}
                              >
                                {t.status === "COMPLETED" ? "완료" : "보유중"}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* 페이징 네비게이션 바 (한 화면 50건) */}
              {statsTradeTotalPages > 1 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    gap: "6px",
                    marginTop: "20px",
                    flexWrap: "wrap",
                  }}
                >
                  {/* 맨 처음으로 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={statsTradePage <= 1 || statsTradeLoading}
                    onClick={() => fetchStatsTrades(1, statsTradeFilterBot)}
                    style={{ padding: "6px 10px", fontSize: "12px" }}
                  >
                    « 처음
                  </button>
                  {/* 이전 페이지 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={statsTradePage <= 1 || statsTradeLoading}
                    onClick={() => fetchStatsTrades(statsTradePage - 1, statsTradeFilterBot)}
                    style={{ padding: "6px 12px", fontSize: "12px" }}
                  >
                    ‹ 이전
                  </button>

                  {/* 페이지 번호 버튼들 (현재 페이지 중심 최대 7개) */}
                  {(() => {
                    const pages = [];
                    const maxButtons = 7;
                    let start = Math.max(1, statsTradePage - Math.floor(maxButtons / 2));
                    let end = Math.min(statsTradeTotalPages, start + maxButtons - 1);
                    if (end - start + 1 < maxButtons) {
                      start = Math.max(1, end - maxButtons + 1);
                    }

                    for (let p = start; p <= end; p++) {
                      pages.push(
                        <button
                          key={p}
                          type="button"
                          className={p === statsTradePage ? "btn btn-primary" : "btn btn-outline"}
                          disabled={statsTradeLoading}
                          onClick={() => fetchStatsTrades(p, statsTradeFilterBot)}
                          style={{
                            padding: "6px 12px",
                            fontSize: "12px",
                            minWidth: "34px",
                            fontWeight: p === statsTradePage ? 700 : 500,
                          }}
                        >
                          {p}
                        </button>
                      );
                    }
                    return pages;
                  })()}

                  {/* 다음 페이지 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={statsTradePage >= statsTradeTotalPages || statsTradeLoading}
                    onClick={() => fetchStatsTrades(statsTradePage + 1, statsTradeFilterBot)}
                    style={{ padding: "6px 12px", fontSize: "12px" }}
                  >
                    다음 ›
                  </button>
                  {/* 맨 끝으로 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={statsTradePage >= statsTradeTotalPages || statsTradeLoading}
                    onClick={() => fetchStatsTrades(statsTradeTotalPages, statsTradeFilterBot)}
                    style={{ padding: "6px 10px", fontSize: "12px" }}
                  >
                    마지막 »
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {(activeMenu === "arena" || activeMenu === "algo-lab") && (
          <div>
            {/* 페이지 상단 헤더 */}
            <div className="page-header">
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <h2 className="page-title">🏆 가상거래 경쟁 (Always-On Arena)</h2>
                  <span
                    style={{
                      fontSize: "12px",
                      padding: "3px 10px",
                      borderRadius: "12px",
                      background: "rgba(16, 185, 129, 0.2)",
                      color: "#34d399",
                      border: "1px solid rgba(16, 185, 129, 0.4)",
                      fontWeight: 700,
                    }}
                  >
                    24시간 무중단 상시 가상 시뮬레이션
                  </span>
                </div>
                <p className="page-desc">
                  수익률이 검증된 10대 코인 알고리즘 봇이 24시간 실시간 업비트 시세를 바탕으로 무중단 가상 경쟁을 펼치며, 실시간 수익률 리더보드를 산출합니다.
                </p>
              </div>

              {/* 우측 액션 버튼 */}
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "10px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  최근 갱신: {algoLabLastUpdated || "-"} (9초 상시)
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleRunAlgoLabCycle}
                  disabled={algoLabCycleRunning}
                  style={{ padding: "8px 14px", fontSize: "12.5px", display: "inline-flex", alignItems: "center", gap: "6px" }}
                >
                  <span>{algoLabCycleRunning ? "⏳" : "🔄"}</span>
                  <span>{algoLabCycleRunning ? "시뮬레이션 중..." : "즉시 시뮬레이션 1사이클"}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={handleResetAlgoLab}
                  disabled={algoLabLoading}
                  style={{ padding: "8px 14px", fontSize: "12.5px" }}
                  title="가상거래 전용 원장(paper_trades)과 10대 봇 가상 잔고를 1,000만 원으로 리셋합니다."
                >
                  초기화 (가상거래 리셋)
                </button>
              </div>
            </div>

            {/* Always-On 상시 가동 상태 배너 */}
            <div className="arena-status-banner">
              <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                <span className="arena-pulse-badge">
                  <span className="arena-pulse-dot" />
                  🟢 상시 가상 시뮬레이션 가동 중 (LLM 필터 제외 · 100% 순수 알고리즘 실시간 경쟁)
                </span>
                <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                  * 시작/중지 버튼 없이 10개 봇이 상시 경쟁하며, 수익률 상위 봇을 설정 메뉴에서 선택하여 실전 매매에 즉시 투입할 수 있습니다.
                </span>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => handleMenuChange("settings")}
                style={{ padding: "6px 14px", fontSize: "12px", borderColor: "rgba(99, 102, 241, 0.4)", color: "#c7d2fe" }}
              >
                ⚙️ 실전 담당 봇 선택 및 투자금 배분 설정 →
              </button>
            </div>

            {/* TOP 3 랭킹 포디움 (Gold 🥇 1위, Silver 🥈 2위, Bronze 🥉 3위) */}
            <div className="podium-container">
              {algoModels.slice(0, 3).map((m, idx) => {
                const rankNum = idx + 1;
                const isFirst = rankNum === 1;
                const badgeClass = isFirst ? "gold" : rankNum === 2 ? "silver" : "bronze";
                const medalIcon = isFirst ? "🥇 1위 (챔피언)" : rankNum === 2 ? "🥈 2위" : "🥉 3위";
                const profitRate = Number(m.profit_rate_pct || 0);

                return (
                  <div key={m.bot_id || m.model_id} className={`podium-card ${badgeClass}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                      <span style={{ fontSize: "15px", fontWeight: 800 }}>{medalIcon}</span>
                      {Number(m.is_selected_for_live) === 1 && (
                        <span className="badge-live-selected">⚡ 실전 담당 중</span>
                      )}
                    </div>

                    <div style={{ fontSize: "17px", fontWeight: 800, color: "#f8fafc", marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>{m.nickname || m.name}</span>
                      {m.bot_id === "bot_10" && (
                        <span style={{ fontSize: "11px", padding: "1px 6px", borderRadius: "4px", background: "rgba(168, 85, 247, 0.25)", color: "#c084fc", fontWeight: 700 }}>
                          VWAP & LRC
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "14px", minHeight: "34px", lineHeight: "1.4" }}>
                      {m.description}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "auto" }}>
                      <div className="meta-item">
                        <span className="meta-label">실시간 누적 수익률</span>
                        <span
                          className="meta-value"
                          style={{
                            fontSize: "20px",
                            fontWeight: 800,
                            color: profitRate > 0 ? "#ef4444" : profitRate < 0 ? "#3b82f6" : "#f8fafc",
                          }}
                        >
                          {profitRate > 0 ? `+${profitRate}%` : `${profitRate}%`}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">총 평가자산</span>
                        <span className="meta-value" style={{ fontSize: "15px", fontWeight: 700 }}>
                          {formatKRW(m.eval_assets_krw)}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">실현손익 (전적)</span>
                        <span className="meta-value" style={{ fontSize: "13px" }}>
                          {renderColoredProfit(m.realized_profit_krw || m.cumulative_profit_krw)}{" "}
                          <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                            ({m.win_trades || 0}승 {m.lose_trades || 0}패)
                          </span>
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">승률 / MDD</span>
                        <span className="meta-value" style={{ fontSize: "13px", color: "#cbd5e1" }}>
                          {m.win_rate_pct || 0}% / <span style={{ color: "#f87171" }}>-{m.mdd_pct || 0}%</span>
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 10대 알고리즘 실시간 수익률 랭킹 보드 (1위 ~ 10위 전체 리더보드) */}
            <div className="card" style={{ marginBottom: "20px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "14px",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <div>
                  <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0 }}>
                    10대 알고리즘 실시간 수익률 랭킹 보드 (순수 수식/기술지표 기반)
                  </h3>
                  <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "3px" }}>
                    * 행을 클릭하면 하단에 해당 봇의 가상 체결 이력만 필터링되어 표시됩니다.
                  </div>
                </div>

                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <button
                    type="button"
                    className={`btn ${selectedAlgoModelId === "all" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => {
                      setSelectedAlgoModelId("all");
                      fetchAlgoLabTrades("all");
                    }}
                    style={{ padding: "5px 12px", fontSize: "12px" }}
                  >
                    전체 봇 체결 보기
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleMenuChange("settings")}
                    style={{ padding: "5px 12px", fontSize: "12px", borderColor: "#6366f1", color: "#a5b4fc" }}
                  >
                    ⚙️ 실전 봇 선택하러 가기
                  </button>
                </div>
              </div>

              <div className="table-container">
                <table className="board-table">
                  <thead>
                    <tr>
                      <th style={{ width: "70px", textAlign: "center" }}>순위</th>
                      <th>봇 별명 / 알고리즘명</th>
                      <th style={{ textAlign: "right" }}>누적 수익률</th>
                      <th style={{ textAlign: "right" }}>총 평가자산</th>
                      <th style={{ textAlign: "right" }}>실현손익</th>
                      <th style={{ textAlign: "center" }}>승률 (전적)</th>
                      <th style={{ textAlign: "center" }}>MDD</th>
                      <th style={{ textAlign: "center" }}>보유 포지션</th>
                      <th style={{ textAlign: "center" }}>실전 담당</th>
                      <th>최근 시그널 상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {algoModels.length === 0 ? (
                      <tr>
                        <td colSpan={10} style={{ textAlign: "center", padding: "32px", color: "#94a3b8" }}>
                          가상 경쟁 리더보드 데이터를 집계하는 중입니다...
                        </td>
                      </tr>
                    ) : (
                      algoModels.map((m) => {
                        const isSelected = selectedAlgoModelId === m.bot_id;
                        const profitRate = Number(m.profit_rate_pct || 0);
                        const isLiveSelected = Number(m.is_selected_for_live) === 1;

                        return (
                          <tr
                            key={m.bot_id}
                            onClick={() => {
                              setSelectedAlgoModelId(m.bot_id);
                              fetchAlgoLabTrades(m.bot_id);
                            }}
                            style={{
                              cursor: "pointer",
                              background: isSelected ? "rgba(99, 102, 241, 0.12)" : "transparent",
                            }}
                          >
                            <td style={{ textAlign: "center", fontWeight: 800 }}>
                              {m.rank === 1 ? "🥇 1위" : m.rank === 2 ? "🥈 2위" : m.rank === 3 ? "🥉 3위" : `${m.rank}위`}
                            </td>
                            <td>
                              <div style={{ fontWeight: 700, fontSize: "14px", color: "#f8fafc", display: "flex", alignItems: "center", gap: "6px" }}>
                                <span>{m.nickname || m.name}</span>
                                {m.bot_id === "bot_10" && (
                                  <span style={{ fontSize: "10.5px", padding: "1px 6px", borderRadius: "4px", background: "rgba(168, 85, 247, 0.25)", color: "#c084fc", fontWeight: 700 }}>
                                    VWAP & LRC
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: "11.5px", color: "#94a3b8" }}>{m.name}</div>
                            </td>
                            <td
                              style={{
                                textAlign: "right",
                                fontWeight: 800,
                                fontSize: "15px",
                                color: profitRate > 0 ? "#ef4444" : profitRate < 0 ? "#3b82f6" : "#f8fafc",
                              }}
                            >
                              {profitRate > 0 ? `+${profitRate}%` : `${profitRate}%`}
                            </td>
                            <td style={{ textAlign: "right", fontWeight: 700 }}>
                              {formatKRW(m.eval_assets_krw)}
                            </td>
                            <td style={{ textAlign: "right" }}>
                              {renderColoredProfit(m.realized_profit_krw || m.cumulative_profit_krw)}
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <span style={{ fontWeight: 600 }}>{m.win_rate_pct || 0}%</span>{" "}
                              <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                                ({m.win_trades || 0}승 {m.lose_trades || 0}패)
                              </span>
                            </td>
                            <td style={{ textAlign: "center", color: "#f87171", fontWeight: 600 }}>
                              -{m.mdd_pct || 0}%
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <span
                                style={{
                                  padding: "2px 8px",
                                  borderRadius: "10px",
                                  fontSize: "12px",
                                  fontWeight: 700,
                                  background: (m.open_positions_count || 0) > 0 ? "rgba(56, 189, 248, 0.2)" : "rgba(148, 163, 184, 0.1)",
                                  color: (m.open_positions_count || 0) > 0 ? "#38bdf8" : "#94a3b8",
                                }}
                              >
                                {m.open_positions_count || 0}건
                              </span>
                            </td>
                            <td style={{ textAlign: "center" }}>
                              {isLiveSelected ? (
                                <span className="badge-live-selected">⚡ 실전</span>
                              ) : (
                                <span style={{ fontSize: "12px", color: "#64748b" }}>가상</span>
                              )}
                            </td>
                            <td>
                              <span style={{ fontSize: "12.5px", color: "#cbd5e1" }}>
                                {m.last_signal_text}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 하단: 가상 매매 체결 일지 (paper_trades) */}
            <div className="card">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "14px",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <div>
                  <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0 }}>
                    실시간 가상 매매 체결 이력{" "}
                    {selectedAlgoModelId !== "all" && (
                      <span style={{ color: "#a5b4fc", fontSize: "14px" }}>
                        ({algoModels.find((m) => m.bot_id === selectedAlgoModelId)?.nickname || selectedAlgoModelId})
                      </span>
                    )}
                  </h3>
                  <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}>
                    실거래와 분리된 전용 가상 원장(paper_trades)에 기록된 모의 체결 내역입니다. (수수료 0.05% 반영)
                  </div>
                </div>

                {selectedAlgoModelId !== "all" && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setSelectedAlgoModelId("all");
                      fetchAlgoLabTrades("all");
                    }}
                    style={{ padding: "4px 10px", fontSize: "12px" }}
                  >
                    ✕ 필터 해제 (전체 내역)
                  </button>
                )}
              </div>

              <div className="table-container">
                <table className="board-table">
                  <thead>
                    <tr>
                      <th style={{ width: "60px" }}>번호</th>
                      <th>알고리즘 봇</th>
                      <th>코인(마켓)</th>
                      <th>매수가 / 매수금액</th>
                      <th>매도가 / 매도금액</th>
                      <th>매수일시</th>
                      <th>매도일시</th>
                      <th>실현손익</th>
                      <th>체결 사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {algoTrades.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ textAlign: "center", padding: "28px", color: "#94a3b8" }}>
                          기록된 가상 매매 체결 이력이 없습니다. 상시 가상 시뮬레이션에 의해 시그널 발생 시 자동 체결됩니다.
                        </td>
                      </tr>
                    ) : (
                      algoTrades.map((t, idx) => (
                        <tr key={t.id || idx}>
                          <td>{algoTrades.length - idx}</td>
                          <td style={{ fontWeight: 700, color: "#cbd5e1" }}>
                            {t.nickname || t.bot_name || t.bot_id}
                          </td>
                          <td style={{ fontWeight: 700 }}>{t.market}</td>
                          <td>
                            <div>{formatKRW(t.buy_amount)}</div>
                            <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                              {Number(t.buy_price).toLocaleString()}원
                            </div>
                          </td>
                          <td>
                            {t.sell_amount ? (
                              <>
                                <div>{formatKRW(t.sell_amount)}</div>
                                <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                                  {Number(t.sell_price).toLocaleString()}원
                                </div>
                              </>
                            ) : (
                              <span style={{ color: "#38bdf8", fontSize: "12px", fontWeight: 600 }}>보유 중</span>
                            )}
                          </td>
                          <td style={{ fontSize: "12px", color: "#94a3b8" }}>{t.buy_date}</td>
                          <td style={{ fontSize: "12px", color: "#94a3b8" }}>{t.sell_date || "-"}</td>
                          <td>
                            {t.profit_krw !== null && t.profit_krw !== undefined ? (
                              <div>
                                {renderColoredProfit(t.profit_krw)}{" "}
                                <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                                  ({t.profit_pct > 0 ? `+${t.profit_pct}` : t.profit_pct}%)
                                </span>
                              </div>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td>
                            <span
                              style={{
                                fontSize: "12px",
                                color: t.status === "HOLDING" ? "#eab308" : "#94a3b8",
                              }}
                            >
                              {t.sell_reason || t.buy_reason || (t.status === "HOLDING" ? "포지션 보유 중" : "체결 완료")}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================
            [메뉴] 실시간 뉴스 피드 & LLM 감성 분석 (50건 페이지네이션, 날짜/키워드 검색, AI 뉴스 판단)
           ============================================================ */}
        {activeMenu === "news" && (
          <div>
            <div className="page-header">
              <div>
                <h2 className="page-title">실시간 뉴스 & LLM 감성 피드</h2>
                <p className="page-desc">
                  주요 가상자산 언론사 및 구글 뉴스를 실시간 수집하고 호재(상승)/악재(하락)/중립 감성 분석 및 키워드를 태깅합니다.
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                {newsNotice && (
                  <span style={{ fontSize: "13px", color: "#38bdf8", fontWeight: 600 }}>
                    {newsNotice}
                  </span>
                )}
                <button
                  type="button"
                  className={`btn ${notificationPermission === "granted" ? "btn-outline" : "btn-primary"}`}
                  onClick={async () => {
                    if (notificationPermission === "granted") {
                      showWebPushNotification("AI 뉴스 분석 완료", "ai 분석이 완료되었습니다", {
                        tag: `push-test-${Date.now()}`,
                      });
                      try {
                        await fetch(`${API_BASE}/api/push/test`, { method: "POST" });
                      } catch (e) {}
                    } else {
                      await registerAndSubscribePush(true);
                    }
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    borderColor: notificationPermission === "granted" ? "rgba(74, 222, 128, 0.4)" : undefined,
                    color: notificationPermission === "granted" ? "#4ade80" : undefined,
                  }}
                  title={
                    notificationPermission === "granted"
                      ? "웹푸시 알림이 활성화되어 있습니다. 클릭 시 즉시 테스트 알림을 발송합니다."
                      : "뉴스 AI 분석 완료 시 'ai 분석이 완료되었습니다' 알림을 받으려면 클릭하여 웹푸시를 켜세요."
                  }
                >
                  <span>{notificationPermission === "granted" ? "🔔" : "🔕"}</span>
                  <span>{notificationPermission === "granted" ? "웹푸시 켜짐 (테스트)" : "웹푸시 알림 켜기"}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleRefreshNews}
                  disabled={newsRefreshing}
                  style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                >
                  <span>{newsRefreshing ? "⏳" : "🔄"}</span>
                  <span>{newsRefreshing ? "뉴스 수집 중..." : "최신 뉴스 즉시 수집"}</span>
                </button>
              </div>
            </div>

            {/* ============================================================
                요구사항: 뉴스를 기반으로 한 AI 판단 설명 (접을 수 있는 영역 & 한 글자씩 스트리밍 타이핑 & 30분 주기 자동 분석)
               ============================================================ */}
            <div className="news-ai-box">
              <div className="news-ai-header">
                <div
                  style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", flex: 1 }}
                  onClick={() => setIsNewsAiExpanded((prev) => !prev)}
                >
                  <span style={{ fontSize: "22px" }}>🤖</span>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                        뉴스 기반 AI 종합 시장 판단 & 퀀트 운용 전략
                      </h3>
                      <span
                        style={{
                          background: "rgba(99, 102, 241, 0.2)",
                          color: "#a5b4fc",
                          padding: "2px 8px",
                          borderRadius: "6px",
                          fontSize: "11px",
                          fontWeight: 600,
                        }}
                      >
                        {isNewsStreaming ? "⚡ 실시간 스트리밍 분석 중" : newsAiBriefing.latest?.model || "Gemini 3.5 Flash Lite"}
                      </span>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          padding: "2px 8px",
                          borderRadius: "12px",
                          background: "rgba(56, 189, 248, 0.15)",
                          color: "#38bdf8",
                          border: "1px solid rgba(56, 189, 248, 0.35)",
                        }}
                        title={
                          geminiQuota?.next_scheduled_at
                            ? `30분 단위 뉴스 감성 & 시장 영향 종합 자동 분석 (다음 자동 분석: ${geminiQuota.next_scheduled_at})`
                            : "30분 주기 뉴스 감성 및 시장 영향 종합 자동 갱신 (매시 00분·30분)"
                        }
                      >
                        ⏰ 30분 단위 자동갱신
                      </span>
                      {!isNewsAiExpanded && newsAiBriefing.latest && (
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginLeft: "4px" }}>
                          <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "6px", background: "rgba(16, 185, 129, 0.16)", color: "#34d399" }}>
                            ▲ 호재 {newsAiBriefing.latest.bullish_count || 0}건
                          </span>
                          <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "6px", background: "rgba(239, 68, 68, 0.16)", color: "#f87171" }}>
                            ▼ 악재 {newsAiBriefing.latest.bearish_count || 0}건
                          </span>
                          <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "6px", background: "rgba(100, 116, 139, 0.2)", color: "#cbd5e1" }}>
                            ● 중립 {newsAiBriefing.latest.neutral_count || 0}건
                          </span>
                        </div>
                      )}
                    </div>
                    <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: "3px 0 0 0" }}>
                      수집된 {newsTotal > 0 ? `${newsTotal}건` : "최신"} 암호화폐 뉴스 헤드라인과 시장 감성을 분석하여 봇 운용 및 단기/중기 시황을 진단합니다.
                      {newsAiBriefing.latest?.created_at &&
                        ` (분석 시각: ${newsAiBriefing.latest.created_at} · ${
                          newsAiBriefing?.last_trigger_type === "AUTO" ? "자동 분석" : "수동 분석"
                        })`}
                    </p>
                  </div>
                </div>

                <div className="news-ai-action-btns">
                  <span
                    style={{
                      fontSize: "11.5px",
                      fontWeight: 700,
                      padding: "6px 10px",
                      borderRadius: "8px",
                      background:
                        Number(geminiQuota?.remaining_calls ?? 30) <= 0
                          ? "rgba(239, 68, 68, 0.18)"
                          : Number(geminiQuota?.remaining_calls ?? 30) <= 3
                          ? "rgba(234, 179, 8, 0.18)"
                          : "rgba(16, 185, 129, 0.16)",
                      color:
                        Number(geminiQuota?.remaining_calls ?? 30) <= 0
                          ? "#f87171"
                          : Number(geminiQuota?.remaining_calls ?? 30) <= 3
                          ? "#facc15"
                          : "#34d399",
                      border: `1px solid ${
                        Number(geminiQuota?.remaining_calls ?? 30) <= 0
                          ? "rgba(239, 68, 68, 0.4)"
                          : Number(geminiQuota?.remaining_calls ?? 30) <= 3
                          ? "rgba(234, 179, 8, 0.4)"
                          : "rgba(16, 185, 129, 0.35)"
                      }`,
                    }}
                    title={`일일 무료 한도 총 ${geminiQuota?.daily_total_limit ?? 50}건 중 자동 분석 예약(${geminiQuota?.auto_reserved_count ?? 6}건)을 제외한 수동 호출 잔여 건수`}
                  >
                    무료 API 잔여: {geminiQuota?.remaining_calls ?? 30}/{geminiQuota?.manual_limit ?? 30}건 (자동예약{" "}
                    {geminiQuota?.auto_reserved_count ?? 6}건 제외)
                  </span>

                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      triggerNewsAiAnalysis();
                    }}
                    disabled={isNewsStreaming || newsAiLoading}
                    style={{
                      padding: "8px 16px",
                      fontSize: "13px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      boxShadow: "0 4px 14px rgba(99, 102, 241, 0.4)",
                    }}
                  >
                    <span>{isNewsStreaming || newsAiLoading ? "⏳" : "⚡"}</span>
                    <span>
                      {isNewsStreaming
                        ? "AI 분석 스트리밍 중..."
                        : newsAiLoading
                        ? "AI 분석 준비 중..."
                        : `AI 분석하기 (${geminiQuota?.remaining_calls ?? 30}건 남음)`}
                    </span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => setIsNewsAiExpanded((prev) => !prev)}
                    style={{ padding: "8px 12px", fontSize: "13px" }}
                  >
                    {isNewsAiExpanded ? "▲ 접기" : "▼ 펼치기"}
                  </button>
                </div>
              </div>

              {/* 접을 수 있는 본문 영역 */}
              {isNewsAiExpanded && (
                <div className="news-ai-body">
                  {/* Gemini 무료 API 호출 잔여 건수 & 듀얼 AI(Flash 30분 / Pro 1시간) 자동 분석 스케줄 안내 바 */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "8px",
                      fontSize: "12px",
                      color: "#cbd5e1",
                      background: "rgba(15, 23, 42, 0.55)",
                      border: "1px solid rgba(99, 102, 241, 0.25)",
                      borderRadius: "8px",
                      padding: "8px 14px",
                      marginBottom: "14px",
                    }}
                  >
                    <div>
                      📊{" "}
                      <strong style={{ color: "#38bdf8" }}>
                        {geminiQuotaNotice ||
                          `금일 자동 분석 예약(${geminiQuota?.auto_reserved_count ?? 6}건) 제외 남은 무료 API 호출 건수: ${geminiQuota?.remaining_calls ?? 30}건 / ${geminiQuota?.manual_limit ?? 30}건`}
                      </strong>
                    </div>
                    <div style={{ color: "#94a3b8", fontSize: "11.5px" }}>
                      매 30분 단위(매시 00분·30분) 실시간 뉴스 종합 감성 자동 분석 실행
                      {geminiQuota?.next_scheduled_at ? ` (다음 예약: ${geminiQuota.next_scheduled_at})` : ""}
                    </div>
                  </div>

                  {/* 로딩 인디케이터 (스트리밍 시작 전 연결 단계) */}
                  {newsAiLoading && (
                    <div
                      style={{
                        padding: "28px 20px",
                        textAlign: "center",
                        background: "rgba(15, 23, 42, 0.4)",
                        borderRadius: "8px",
                        marginBottom: "14px",
                      }}
                    >
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#f8fafc", marginBottom: "6px" }}>
                        ⚡ 실시간 암호화폐 뉴스 & 감성 지표 취합 및 Gemini 연결 중...
                      </div>
                      <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                        수집된 최신 뉴스 헤드라인, 호재/악재 감성 비중, 메이저 코인 시세를 취합하여 맞춤형 스트리밍 브리핑을 준비하고 있습니다.
                      </div>
                    </div>
                  )}

                  {/* 스트리밍 중이거나 완료된 브리핑이 있을 때 */}
                  {isNewsStreaming ? (
                    <div>
                      {newsStreamingMeta && (
                        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "14px", alignItems: "center" }}>
                          <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(16, 185, 129, 0.15)", color: "#34d399" }}>
                            ▲ 호재: {newsStreamingMeta.bullish_count}건
                          </span>
                          <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(239, 68, 68, 0.15)", color: "#f87171" }}>
                            ▼ 악재: {newsStreamingMeta.bearish_count}건
                          </span>
                          <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(100, 116, 139, 0.2)", color: "#94a3b8" }}>
                            ● 중립: {newsStreamingMeta.neutral_count}건
                          </span>
                          <div style={{ fontSize: "12px", color: "#38bdf8", marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
                            <span className="spinner" style={{ width: "12px", height: "12px" }} />
                            한 자씩 실시간 타이핑 중...
                          </div>
                        </div>
                      )}
                      <MarkdownViewer content={newsStreamingText} isStreaming={true} />
                    </div>
                  ) : !newsAiLoading && newsAiBriefing.latest?.briefing_text ? (
                    <div>
                      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
                        <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(16, 185, 129, 0.15)", color: "#34d399" }}>
                          ▲ 호재: {newsAiBriefing.latest.bullish_count || 0}건
                        </span>
                        <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(239, 68, 68, 0.15)", color: "#f87171" }}>
                          ▼ 악재: {newsAiBriefing.latest.bearish_count || 0}건
                        </span>
                        <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(100, 116, 139, 0.2)", color: "#94a3b8" }}>
                          ● 중립: {newsAiBriefing.latest.neutral_count || 0}건
                        </span>
                        <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(99, 102, 241, 0.15)", color: "#a5b4fc" }}>
                          모델: {newsAiBriefing.latest.model}
                        </span>
                      </div>
                      <MarkdownViewer content={newsAiBriefing.latest.briefing_text} isStreaming={false} />
                    </div>
                  ) : newsStreamingText ? (
                    <div style={{ whiteSpace: "pre-line", wordBreak: "break-word" }}>
                      {newsStreamingText}
                    </div>
                  ) : (
                    <div style={{ textAlign: "center", padding: "28px 16px", color: "var(--text-secondary)" }}>
                      <p style={{ margin: "0 0 12px 0", fontSize: "14px" }}>
                        아직 생성된 뉴스 종합 분석 리포트가 없습니다.
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={triggerNewsAiAnalysis}
                        disabled={newsAiLoading}
                        style={{ fontSize: "13px", padding: "8px 18px" }}
                      >
                        🤖 지금 AI 실시간 뉴스 종합 분석 시작
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 검색 및 필터 카드 (날짜 범위, 키워드 검색, 태그 필터) */}
            <div className="card" style={{ marginBottom: "16px" }}>
              <form onSubmit={handleSearchNews}>
                <div className="news-filter-grid">
                  {/* 날짜 범위: 시작일 */}
                  <div className="news-date-col">
                    <label style={{ display: "block", fontSize: "12px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                      📅 시작일
                    </label>
                    <input
                      type="date"
                      className="form-input"
                      style={{ width: "100%", padding: "8px 10px", fontSize: "13px" }}
                      value={newsStartDate}
                      onChange={(e) => setNewsStartDate(e.target.value)}
                    />
                  </div>

                  {/* 날짜 범위: 종료일 */}
                  <div className="news-date-col">
                    <label style={{ display: "block", fontSize: "12px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                      📅 종료일
                    </label>
                    <input
                      type="date"
                      className="form-input"
                      style={{ width: "100%", padding: "8px 10px", fontSize: "13px" }}
                      value={newsEndDate}
                      onChange={(e) => setNewsEndDate(e.target.value)}
                    />
                  </div>

                  {/* 키워드 검색창 */}
                  <div className="news-keyword-col">
                    <label style={{ display: "block", fontSize: "12px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                      🔍 키워드 검색 (제목, 요약, 언론사, 해시태그)
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      style={{ width: "100%", padding: "8px 12px", fontSize: "13px" }}
                      placeholder="검색어 입력 (예: 비트코인, 업비트, ETF, 급등, SEC, 해킹...)"
                      value={newsKeyword}
                      onChange={(e) => setNewsKeyword(e.target.value)}
                    />
                  </div>

                  {/* 검색 & 초기화 버튼 */}
                  <div className="news-btn-col">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      style={{ padding: "8px 16px", fontSize: "13px" }}
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={handleResetNewsFilter}
                      style={{ padding: "8px 14px", fontSize: "13px" }}
                    >
                      초기화
                    </button>
                  </div>
                </div>

                {/* 추천 키워드 태그 클릭 바로가기 */}
                <div className="news-popular-tags-wrap" style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>인기 태그:</span>
                  {[
                    "#비트코인",
                    "#이더리움",
                    "#업비트",
                    "#리플",
                    "#솔라나",
                    "#ETF",
                    "#규제/정책",
                    "#시황/전망",
                    "#해킹/보안",
                    "상승",
                    "하락",
                  ].map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleQuickTagClick(tag)}
                      style={{
                        background: "rgba(38, 50, 77, 0.6)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "14px",
                        padding: "3px 10px",
                        fontSize: "12px",
                        color: "#93c5fd",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "rgba(99, 102, 241, 0.3)";
                        e.currentTarget.style.borderColor = "var(--accent-indigo)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "rgba(38, 50, 77, 0.6)";
                        e.currentTarget.style.borderColor = "var(--border-color)";
                      }}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </form>
            </div>

            {/* 뉴스 목록 테이블 카드 (한 화면 50건, row 높이 동일화) */}
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                <span style={{ fontSize: "14px", color: "var(--text-secondary)" }}>
                  총 <strong style={{ color: "#f8fafc" }}>{newsTotal.toLocaleString()}</strong>건의 뉴스 중{" "}
                  {newsTotal > 0 ? (
                    <>
                      <strong style={{ color: "var(--accent-indigo)" }}>
                        {(newsPage - 1) * 50 + 1} ~ {Math.min(newsPage * 50, newsTotal)}
                      </strong>
                      건 표시 (페이지 {newsPage} / {newsTotalPages}, 한 화면 50건)
                    </>
                  ) : (
                    "0건 표시"
                  )}
                </span>
                {newsLoading && (
                  <span style={{ fontSize: "13px", color: "var(--accent-indigo)" }}>
                    ⏳ 목록 조회 중...
                  </span>
                )}
              </div>

              <div className="table-container">
                <table className="board-table news-board-table">
                  <thead>
                    <tr>
                      <th style={{ width: "55px", textAlign: "center" }}>No</th>
                      <th style={{ width: "95px", textAlign: "center" }}>감성 분석</th>
                      <th>기사 제목</th>
                      <th style={{ width: "140px" }}>주요 태그</th>
                      <th style={{ width: "130px" }}>언론사</th>
                      <th style={{ width: "150px", textAlign: "center" }}>발행 일시 (KST)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {newsList.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: "48px 16px", color: "var(--text-secondary)" }}>
                          {newsLoading
                            ? "뉴스를 불러오는 중입니다..."
                            : "등록된 뉴스가 없거나 검색 조건에 일치하는 뉴스가 없습니다. 검색어를 변경하거나 [최신 뉴스 즉시 수집]을 눌러보세요."}
                        </td>
                      </tr>
                    ) : (
                      newsList.map((item, idx) => {
                        const itemNumber = (newsPage - 1) * 50 + idx + 1;
                        const sentiment = item.sentiment || "NEUTRAL";
                        const isBullish = sentiment === "BULLISH";
                        const isBearish = sentiment === "BEARISH";

                        return (
                          <tr key={item.id || item.link || idx}>
                            <td style={{ textAlign: "center", color: "var(--text-secondary)", fontSize: "12px" }}>
                              {itemNumber}
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "3px 8px",
                                  borderRadius: "6px",
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  background: isBullish
                                    ? "rgba(16, 185, 129, 0.15)"
                                    : isBearish
                                    ? "rgba(239, 68, 68, 0.15)"
                                    : "rgba(100, 116, 139, 0.18)",
                                  color: isBullish
                                    ? "#34d399"
                                    : isBearish
                                    ? "#f87171"
                                    : "#94a3b8",
                                  border: `1px solid ${
                                    isBullish
                                      ? "rgba(16, 185, 129, 0.35)"
                                      : isBearish
                                      ? "rgba(239, 68, 68, 0.35)"
                                      : "rgba(100, 116, 139, 0.3)"
                                  }`,
                                }}
                              >
                                {isBullish ? "▲ 호재" : isBearish ? "▼ 악재" : "● 중립"}
                              </span>
                            </td>
                            <td title={item.title + (item.summary ? `\n[요약] ${item.summary}` : "")}>
                              <a
                                href={item.link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="news-title-link"
                              >
                                {item.title}
                                <span style={{ fontSize: "11px", marginLeft: "4px", color: "#64748b" }}>↗</span>
                              </a>
                            </td>
                            <td title={item.keywords || ""}>
                              <span style={{ fontSize: "12px", color: "#38bdf8" }}>
                                {item.keywords || "-"}
                              </span>
                            </td>
                            <td title={item.source || ""}>
                              <span style={{ fontSize: "12.5px", color: "#cbd5e1" }}>
                                {item.source || "Google News"}
                              </span>
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                                {item.published_at || "-"}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* 페이지네이션 컨트롤 (한 화면 50건 단위) */}
              {newsTotalPages > 1 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    gap: "6px",
                    marginTop: "20px",
                    flexWrap: "wrap",
                  }}
                >
                  {/* 맨 처음으로 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={newsPage <= 1 || newsLoading}
                    onClick={() => fetchNews(1)}
                    style={{ padding: "6px 10px", fontSize: "12px" }}
                  >
                    « 처음
                  </button>
                  {/* 이전 페이지 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={newsPage <= 1 || newsLoading}
                    onClick={() => fetchNews(newsPage - 1)}
                    style={{ padding: "6px 12px", fontSize: "12px" }}
                  >
                    ‹ 이전
                  </button>

                  {/* 페이지 번호 버튼들 (현재 페이지 중심 최대 7개 노출) */}
                  {(() => {
                    const pages = [];
                    const maxButtons = 7;
                    let start = Math.max(1, newsPage - Math.floor(maxButtons / 2));
                    let end = Math.min(newsTotalPages, start + maxButtons - 1);
                    if (end - start + 1 < maxButtons) {
                      start = Math.max(1, end - maxButtons + 1);
                    }

                    for (let p = start; p <= end; p++) {
                      pages.push(
                        <button
                          key={p}
                          type="button"
                          className={p === newsPage ? "btn btn-primary" : "btn btn-outline"}
                          disabled={newsLoading}
                          onClick={() => fetchNews(p)}
                          style={{
                            padding: "6px 12px",
                            fontSize: "12px",
                            minWidth: "34px",
                            fontWeight: p === newsPage ? 700 : 500,
                          }}
                        >
                          {p}
                        </button>
                      );
                    }
                    return pages;
                  })()}

                  {/* 다음 페이지 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={newsPage >= newsTotalPages || newsLoading}
                    onClick={() => fetchNews(newsPage + 1)}
                    style={{ padding: "6px 12px", fontSize: "12px" }}
                  >
                    다음 ›
                  </button>
                  {/* 맨 끝으로 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={newsPage >= newsTotalPages || newsLoading}
                    onClick={() => fetchNews(newsTotalPages)}
                    style={{ padding: "6px 10px", fontSize: "12px" }}
                  >
                    마지막 »
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============================================================
            [메뉴 3] 설정 (요구사항 13, 15, 22)
           ============================================================ */}
        {activeMenu === "settings" && (
          <div>
            <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <h2 className="page-title">설정</h2>
                <p className="page-desc">
                  거래 실행 모드(가상거래/실거래), 봇별 자금 분배 비율, 봇 별명 및 전략 파라미터 수정, 데이터 마이그레이션을 관리합니다.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => {
                  setWizardStep(1);
                  setShowSetupWizard(true);
                }}
                style={{
                  padding: "9px 16px",
                  fontSize: "13px",
                  fontWeight: 700,
                  background: "linear-gradient(135deg, rgba(99, 102, 241, 0.25), rgba(30, 41, 70, 0.5))",
                  borderColor: "#6366f1",
                  color: "#c7d2fe",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  borderRadius: "8px",
                }}
              >
                <span>🛠️</span>
                <span>초기 설정 마법사 다시 열기</span>
              </button>
            </div>

            {/* 거래 실행 모드 설정 (가상거래 모의투자 ↔ 업비트 실거래) */}
            <div
              className="card"
              style={{
                background: tradeMode.mode === "paper" ? "linear-gradient(135deg, rgba(30, 27, 75, 0.7), rgba(15, 23, 42, 0.9))" : "linear-gradient(135deg, rgba(69, 10, 10, 0.7), rgba(15, 23, 42, 0.9))",
                border: tradeMode.mode === "paper" ? "1px solid rgba(99, 102, 241, 0.5)" : "1px solid rgba(239, 68, 68, 0.5)",
                marginBottom: "20px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                      ⚡ 거래 실행 모드 설정
                    </h3>
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: "12px",
                        fontSize: "12px",
                        fontWeight: 700,
                        background: tradeMode.mode === "paper" ? "rgba(99, 102, 241, 0.25)" : "rgba(239, 68, 68, 0.25)",
                        color: tradeMode.mode === "paper" ? "#a5b4fc" : "#fca5a5",
                        border: tradeMode.mode === "paper" ? "1px solid #6366f1" : "1px solid #ef4444",
                      }}
                    >
                      {tradeMode.mode === "paper" ? "🧪 가상거래(모의투자) 모드 동작 중" : "⚡ 업비트 실거래 모드 동작 중"}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: "12.5px", color: "#cbd5e1", lineHeight: 1.5 }}>
                    {tradeMode.mode === "paper"
                      ? "현재 모드는 가상거래(모의투자)입니다. 실제 업비트 실시간 호가/시세 및 기술지표를 그대로 사용하여 매수/매도 신호를 포착하지만, 업비트 주문 API를 호출하지 않고 가상 체결(수수료 0.05% 반영)로 안전하게 거래를 시뮬레이션합니다."
                      : "현재 모드는 실제 업비트 계좌 실거래입니다! 봇의 매수/매도 주문이 실제 업비트 거래소 API를 통해 실제 원화/코인으로 즉시 체결됩니다. 주의하여 운용하십시오."}
                  </p>
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  {tradeMode.mode === "paper" && (
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={handleResetPaperTrades}
                      disabled={paperResetLoading}
                      style={{ padding: "8px 14px", fontSize: "13px", borderColor: "#818cf8", color: "#c7d2fe" }}
                      title="가상 체결 이력 및 포지션을 삭제하고 알고리즘 검증소 모델(100만 원)을 초기화합니다."
                    >
                      {paperResetLoading ? "초기화 중..." : "🔄 가상거래 이력 초기화"}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`btn ${tradeMode.mode === "paper" ? "btn-stop" : "btn-primary"}`}
                    onClick={() => handleToggleTradeMode(tradeMode.mode === "paper" ? "live" : "paper")}
                    disabled={tradeMode.loading}
                    style={{
                      padding: "8px 16px",
                      fontSize: "13px",
                      fontWeight: 700,
                    }}
                  >
                    {tradeMode.loading ? "모드 전환 중..." : tradeMode.mode === "paper" ? "⚡ 업비트 실거래로 전환" : "🧪 가상거래(모의투자)로 전환"}
                  </button>
                </div>
              </div>
            </div>

            {/* 상단: 실제 업비트에서 가져온 실 계좌 잔고 및 총 보유 자산 (수정 불가 / 읽기 전용 영역) */}
            <div
              className="card"
              style={{
                background: "#0f172a",
                border: "1px solid #334155",
                marginBottom: "20px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "12px",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                    🔒 업비트 실 계좌 잔고 및 총 보유 자산 (KRW)
                  </h3>
                  <span
                    style={{
                      fontSize: "11px",
                      background: "#1e293b",
                      color: "#94a3b8",
                      border: "1px solid #475569",
                      borderRadius: "4px",
                      padding: "2px 6px",
                    }}
                  >
                    읽기 전용 · 수정 불가
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: "5px 12px", fontSize: "12px" }}
                  onClick={fetchUpbitAccount}
                  disabled={upbitAccount.loading}
                >
                  {upbitAccount.loading ? "조회 중..." : "실계좌/총자산 새로고침"}
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                <div>
                  <div style={{ fontSize: "12.5px", color: "#94a3b8", marginBottom: "6px", fontWeight: 600 }}>
                    실 계좌 잔고 (주문 가능 KRW)
                  </div>
                  <input
                    type="text"
                    readOnly
                    disabled
                    className="form-input"
                    style={{
                      width: "100%",
                      background: "#1e293b",
                      color: upbitAccount.success ? "#38bdf8" : "#f87171",
                      fontWeight: 700,
                      cursor: "not-allowed",
                      opacity: 1,
                      WebkitTextFillColor: upbitAccount.success ? "#38bdf8" : "#f87171",
                    }}
                    value={
                      upbitAccount.loading
                        ? "조회 중..."
                        : upbitAccount.success && upbitAccount.krw_balance !== null
                        ? `${Number(upbitAccount.krw_balance).toLocaleString("ko-KR")}원 (주문중: ${Number(
                            upbitAccount.krw_locked ?? 0
                          ).toLocaleString("ko-KR")}원)`
                        : upbitAccount.message || "조회 실패"
                    }
                  />
                </div>

                <div>
                  <div style={{ fontSize: "12.5px", color: "#94a3b8", marginBottom: "6px", fontWeight: 600 }}>
                    총 보유 자산 (실계좌 원화 + 코인 평가금액 / 운용 원금 한도)
                  </div>
                  <input
                    type="text"
                    readOnly
                    disabled
                    className="form-input"
                    style={{
                      width: "100%",
                      background: "#1e293b",
                      color: upbitAccount.success ? "#4ade80" : "#f87171",
                      fontWeight: 700,
                      cursor: "not-allowed",
                      opacity: 1,
                      WebkitTextFillColor: upbitAccount.success ? "#4ade80" : "#f87171",
                    }}
                    value={
                      upbitAccount.loading
                        ? "조회 중..."
                        : upbitAccount.success && upbitAccount.total_asset_krw !== null
                        ? `${Number(upbitAccount.total_asset_krw).toLocaleString("ko-KR")}원 (코인평가: ${Number(
                            upbitAccount.total_eval_krw ?? 0
                          ).toLocaleString("ko-KR")}원)`
                        : upbitAccount.message || "조회 실패"
                    }
                  />
                </div>
              </div>

              {upbitAccount.checked_at && (
                <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "8px" }}>
                  최근 조회 시각: {upbitAccount.checked_at} | {upbitAccount.message}
                </div>
              )}
            </div>

            {/* 1. 실제 거래 담당 봇(1~3개) 선택 및 동적 투자금 배분 설정 */}
            <div className="card" style={{ marginBottom: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "16px" }}>
                <div>
                  <h3 style={{ fontSize: "17px", fontWeight: 800, margin: 0, color: "#f8fafc", display: "flex", alignItems: "center", gap: "8px" }}>
                    <span>🎯</span> 1. 실제 거래 담당 봇 선택 및 동적 투자금 배분
                  </h3>
                  <p style={{ margin: "4px 0 0 0", fontSize: "12.5px", color: "#94a3b8" }}>
                    10대 순수 알고리즘 봇 중 실제 거래를 수행할 봇을 <strong>최소 1개 ~ 최대 3개</strong> 선택하십시오. 선택된 봇들에게만 실전 운용 원금이 동적으로 배분됩니다.
                  </p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span
                    style={{
                      padding: "5px 12px",
                      borderRadius: "20px",
                      fontSize: "12.5px",
                      fontWeight: 700,
                      background: selectedLiveBotIds.length >= 1 && selectedLiveBotIds.length <= 3 ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
                      color: selectedLiveBotIds.length >= 1 && selectedLiveBotIds.length <= 3 ? "#34d399" : "#f87171",
                      border: selectedLiveBotIds.length >= 1 && selectedLiveBotIds.length <= 3 ? "1px solid rgba(16, 185, 129, 0.3)" : "1px solid rgba(239, 68, 68, 0.3)",
                    }}
                  >
                    현재 선택: {selectedLiveBotIds.length}개 / 최대 3개 (최소 1개)
                  </span>
                </div>
              </div>

              {/* Step 1: 10대 봇 선택 체크박스 카드 리스트 */}
              <div style={{ marginBottom: "24px" }}>
                <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#e2e8f0", marginBottom: "10px", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ background: "#3b82f6", color: "#fff", borderRadius: "50%", width: "20px", height: "20px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "11px" }}>1</span>
                  <span>10대 알고리즘 봇 중 실전 거래 담당 봇 선택 (클릭하여 토글)</span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "12px" }}>
                  {(algoModels.length > 0 ? algoModels : bots).map((bot, idx) => {
                    const isSelected = selectedLiveBotIds.includes(bot.bot_id);
                    const rank = bot.rank || idx + 1;
                    const retPct = bot.total_return_pct ?? bot.profit_rate_pct ?? 0;
                    return (
                      <div
                        key={bot.bot_id}
                        className={`bot-select-card ${isSelected ? "selected" : ""}`}
                        onClick={() => handleToggleLiveBotSelection(bot.bot_id)}
                        style={{
                          background: isSelected ? "linear-gradient(135deg, rgba(30, 58, 138, 0.35), rgba(15, 23, 42, 0.85))" : "#111827",
                          border: isSelected ? "2px solid #3b82f6" : "1px solid #1f2937",
                          borderRadius: "10px",
                          padding: "14px",
                          cursor: "pointer",
                          transition: "all 0.2s ease",
                          position: "relative",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              readOnly
                              style={{ width: "16px", height: "16px", cursor: "pointer", accentColor: "#3b82f6", pointerEvents: "none" }}
                            />
                            <span style={{ fontWeight: 800, fontSize: "14px", color: isSelected ? "#93c5fd" : "#f1f5f9", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                              <span>{bot.nickname || bot.name}</span>
                              {bot.bot_id === "bot_10" && (
                                <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "4px", background: "rgba(168, 85, 247, 0.25)", color: "#c084fc", fontWeight: 700 }}>
                                  VWAP & LRC
                                </span>
                              )}
                            </span>
                          </div>
                          <span
                            style={{
                              fontSize: "11px",
                              padding: "2px 7px",
                              borderRadius: "10px",
                              fontWeight: 700,
                              background: rank === 1 ? "rgba(251, 191, 36, 0.2)" : rank === 2 ? "rgba(203, 213, 225, 0.2)" : rank === 3 ? "rgba(249, 115, 22, 0.2)" : "rgba(71, 85, 105, 0.3)",
                              color: rank === 1 ? "#fbbf24" : rank === 2 ? "#e2e8f0" : rank === 3 ? "#fb923c" : "#94a3b8",
                            }}
                          >
                            #{rank}위
                          </span>
                        </div>

                        <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "8px", lineHeight: "1.4" }}>
                          {bot.description || bot.strategy_desc || bot.strategy || bot.bot_id}
                        </div>

                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "8px" }}>
                          <span style={{ color: "#64748b" }}>가상 수익률</span>
                          <span style={{ fontWeight: 700, color: retPct >= 0 ? "#f87171" : "#38bdf8" }}>
                            {retPct >= 0 ? `+${retPct.toFixed(2)}%` : `${retPct.toFixed(2)}%`}
                          </span>
                        </div>

                        <div style={{ marginTop: "6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span
                            style={{
                              fontSize: "10.5px",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontWeight: 700,
                              background: isSelected ? "rgba(59, 130, 246, 0.2)" : "rgba(75, 85, 99, 0.2)",
                              color: isSelected ? "#60a5fa" : "#6b7280",
                            }}
                          >
                            {isSelected ? "⚡ 실전 담당 중" : "가상 시뮬레이션 전용"}
                          </span>
                          <span style={{ fontSize: "11px", color: "#64748b" }}>
                            {bot.market || "KRW-BTC"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Step 2: 선택된 실전 봇 동적 투자금 설정 패널 (선택된 1~3개 봇만 동적 렌더링) */}
              <div
                style={{
                  background: "#0b0f19",
                  border: "1px solid #1e293b",
                  borderRadius: "10px",
                  padding: "18px",
                }}
              >
                {isLiveConfigDirty && (
                  <div
                    style={{
                      background: "rgba(245, 158, 11, 0.15)",
                      border: "1px solid #f59e0b",
                      borderRadius: "8px",
                      padding: "10px 14px",
                      marginBottom: "14px",
                      color: "#fde68a",
                      fontSize: "12.5px",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <span style={{ fontSize: "16px" }}>⚠️</span>
                    <span>
                      실전 봇 구성 또는 비율이 변경되었습니다. 아래 각 봇의 비율을 확인하신 후(슬라이더 조작 시 합계 100% 자동 유지), 반드시 하단의 <strong>[💾 실전 거래 담당 봇 및 투자금 설정 저장]</strong>을 눌러야 실제 투자가 활성화됩니다.
                    </span>
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "14px" }}>
                  <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#e2e8f0", display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ background: "#10b981", color: "#fff", borderRadius: "50%", width: "20px", height: "20px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "11px" }}>2</span>
                    <span>선택된 실전 봇({selectedLiveBotIds.length}개) 동적 투자금 및 비율(%) 배분 (항상 합계 100% 자동 연동)</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleDistributeEvenly}
                    style={{ padding: "5px 12px", fontSize: "12px", fontWeight: 600 }}
                  >
                    ⚖️ 균등 배분 (100% N등분)
                  </button>
                </div>

                <form onSubmit={handleSaveLiveBotsAllocation}>
                  {/* 업비트 실계좌 잔고 기반 90% 자동 동적 운영 원금 대시보드 */}
                  {(() => {
                    const upbitAsset = Number(upbitAccount.total_asset_krw ?? upbitAccount.krw_total ?? upbitAccount.krw_balance ?? 0);
                    const dynamicCapital = Math.floor(upbitAsset * 0.9);
                    const safeBuffer = Math.max(0, upbitAsset - dynamicCapital);

                    return (
                      <div
                        style={{
                          marginBottom: "18px",
                          background: "linear-gradient(135deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0.9) 100%)",
                          border: "1px solid rgba(56, 189, 248, 0.35)",
                          borderRadius: "10px",
                          padding: "16px 18px",
                          boxShadow: "0 4px 16px -2px rgba(0, 0, 0, 0.25)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: "12px",
                            marginBottom: "12px",
                          }}
                        >
                          <div>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span style={{ fontSize: "18px" }}>⚡</span>
                              <strong style={{ fontSize: "15px", color: "#f8fafc" }}>
                                실전 운영 원금 자동 동적 설정 (업비트 실계좌 잔고 90%)
                              </strong>
                              <span
                                style={{
                                  fontSize: "11px",
                                  padding: "2px 8px",
                                  borderRadius: "10px",
                                  background: "rgba(16, 185, 129, 0.2)",
                                  color: "#6ee7b7",
                                  border: "1px solid rgba(16, 185, 129, 0.4)",
                                  fontWeight: 700,
                                }}
                              >
                                자동 90% 동적 연동
                              </span>
                            </div>
                            <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "3px" }}>
                              사용자가 수동으로 원금을 입력하지 않아도, 실제 업비트 실계좌 잔고의 90%가 실시간 자동 계산되어 선택된 봇들에게 비율대로 분배됩니다.
                            </div>
                          </div>

                          <div
                            style={{
                              padding: "4px 10px",
                              borderRadius: "6px",
                              background: "rgba(56, 189, 248, 0.15)",
                              color: "#38bdf8",
                              fontSize: "12px",
                              fontWeight: 600,
                              border: "1px solid rgba(56, 189, 248, 0.3)",
                            }}
                          >
                            🛡️ 10% 안전 버퍼: {safeBuffer.toLocaleString("ko-KR")}원 보존
                          </div>
                        </div>

                        {/* 잔고 → 90% 변환 상태 바 */}
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                            gap: "10px",
                            background: "rgba(15, 23, 42, 0.6)",
                            padding: "12px 14px",
                            borderRadius: "8px",
                            border: "1px solid rgba(255, 255, 255, 0.05)",
                          }}
                        >
                          <div>
                            <span style={{ fontSize: "11.5px", color: "#94a3b8" }}>실제 업비트 계좌 잔고 (총 자산)</span>
                            <div style={{ fontSize: "16px", fontWeight: 700, color: "#cbd5e1", marginTop: "2px" }}>
                              {upbitAccount.success && upbitAsset > 0
                                ? `${upbitAsset.toLocaleString("ko-KR")}원`
                                : "계좌 잔고 조회 중..."}
                            </div>
                          </div>
                          <div>
                            <span style={{ fontSize: "11.5px", color: "#38bdf8", fontWeight: 600 }}>
                              자동 설정된 총 운영 원금 (90%)
                            </span>
                            <div style={{ fontSize: "18px", fontWeight: 800, color: "#4ade80", marginTop: "2px" }}>
                              {dynamicCapital > 0 ? `${dynamicCapital.toLocaleString("ko-KR")}원` : "0원"}
                            </div>
                          </div>
                          <div>
                            <span style={{ fontSize: "11.5px", color: "#94a3b8" }}>실전 봇 총 배분 대상</span>
                            <div style={{ fontSize: "14px", fontWeight: 600, color: "#f1f5f9", marginTop: "4px" }}>
                              선택된 {selectedLiveBotIds.length}개 봇에 100% 비율 분배
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* 선택된 실전 봇만 동적으로 렌더링되는 자금 배분 그리드 */}
                  {selectedLiveBotIds.length === 0 ? (
                    <div style={{ padding: "20px", textAlign: "center", color: "#94a3b8", background: "#111827", borderRadius: "8px" }}>
                      상단에서 실전 거래를 담당할 봇을 최소 1개 이상 선택하십시오.
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(280px, 1fr))`, gap: "14px", marginBottom: "18px" }}>
                      {selectedLiveBotIds.map((botId) => {
                        const botObj = (algoModels.length > 0 ? algoModels : bots).find((b) => b.bot_id === botId) || {
                          bot_id: botId,
                          nickname: botId,
                          name: botId,
                        };
                        const ratio = liveAllocRatios[botId] ?? 0;
                        const upbitAsset = Number(upbitAccount.total_asset_krw ?? upbitAccount.krw_total ?? upbitAccount.krw_balance ?? 0);
                        const dynamicCap = Math.floor(upbitAsset * 0.9);
                        const numericCap = dynamicCap > 0 ? dynamicCap : parseNumericInput(totalCapitalInput) || 0;
                        const allocatedKrw = Math.floor(numericCap * (Number(ratio) / 100));

                        return (
                          <div
                            key={botId}
                            style={{
                              background: "#161f33",
                              border: "1px solid #26324d",
                              borderRadius: "10px",
                              padding: "16px",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                              <div style={{ fontWeight: 800, fontSize: "15px", color: "#93c5fd" }}>
                                {botObj.nickname || botObj.name}
                              </div>
                              <span style={{ fontSize: "11px", color: "#64748b" }}>{botId}</span>
                            </div>

                            <div style={{ marginBottom: "12px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12.5px", marginBottom: "6px" }}>
                                <span style={{ color: "#94a3b8" }}>투자 비율 (%)</span>
                                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                  <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    className="form-input"
                                    value={ratio}
                                    onChange={(e) => handleLiveRatioChange(botId, e.target.value)}
                                    style={{ width: "65px", padding: "4px 8px", fontSize: "13px", fontWeight: 700, textAlign: "right" }}
                                  />
                                  <span style={{ color: "#38bdf8", fontWeight: 700 }}>%</span>
                                </div>
                              </div>
                              <input
                                type="range"
                                min="0"
                                max="100"
                                step="1"
                                value={ratio}
                                onChange={(e) => handleLiveRatioChange(botId, e.target.value)}
                                style={{ width: "100%", accentColor: "#3b82f6", cursor: "pointer", marginBottom: "4px" }}
                              />
                              <div style={{ fontSize: "10.5px", color: "#64748b" }}>
                                슬라이더 조절 시 다른 봇들의 비율이 자동 계산되어 항상 100%가 유지됩니다.
                              </div>
                            </div>

                            <div style={{ background: "#0f172a", borderRadius: "6px", padding: "10px", fontSize: "12px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
                                <span style={{ color: "#94a3b8" }}>실시간 배정 원금</span>
                                <strong style={{ color: "#4ade80", fontSize: "13px" }}>
                                  {allocatedKrw.toLocaleString("ko-KR")}원
                                </strong>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b", fontSize: "11px" }}>
                                <span>적용 수식</span>
                                <span>{numericCap.toLocaleString("ko-KR")}원(90%) × {ratio}%</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* 배분 요약 바 및 저장 버튼 */}
                  {selectedLiveBotIds.length > 0 && (() => {
                    const ratioSum = selectedLiveBotIds.reduce((sum, id) => sum + Number(liveAllocRatios[id] || 0), 0);
                    const upbitAsset = Number(upbitAccount.total_asset_krw ?? upbitAccount.krw_total ?? upbitAccount.krw_balance ?? 0);
                    const dynamicCap = Math.floor(upbitAsset * 0.9);
                    const numericCap = dynamicCap > 0 ? dynamicCap : parseNumericInput(totalCapitalInput) || 0;
                    const totalAlloc = selectedLiveBotIds.reduce((sum, id) => {
                      return sum + Math.floor(numericCap * (Number(liveAllocRatios[id] || 0) / 100));
                    }, 0);
                    const is100 = Math.abs(ratioSum - 100) < 0.1;

                    return (
                      <div style={{ background: "#111827", borderRadius: "8px", padding: "14px", border: "1px solid #1f2937" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "12px" }}>
                          <div>
                            <div style={{ fontSize: "12px", color: "#94a3b8" }}>비율 합계 검증</div>
                            <div style={{ fontSize: "15px", fontWeight: 800, color: is100 ? "#4ade80" : "#f87171" }}>
                              {ratioSum}% {is100 ? "✓ 100% 일치" : "(정확히 100%여야 저장 가능)"}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: "12px", color: "#94a3b8" }}>실전 봇 총 배정 원금</div>
                            <div style={{ fontSize: "15px", fontWeight: 800, color: "#f8fafc" }}>
                              {totalAlloc.toLocaleString("ko-KR")}원
                            </div>
                          </div>
                        </div>

                        <button
                          type="submit"
                          className="btn btn-primary"
                          disabled={savingLiveBots || !is100 || !(numericCap > 0)}
                          style={{
                            width: "100%",
                            padding: "12px",
                            fontSize: "14px",
                            fontWeight: 700,
                            opacity: savingLiveBots || !is100 || !(numericCap > 0) ? 0.6 : 1,
                          }}
                        >
                          {savingLiveBots ? "실전 봇 및 자금 배분 저장 중..." : "💾 실전 거래 담당 봇 및 투자금 설정 저장"}
                        </button>
                      </div>
                    );
                  })()}
                </form>
              </div>
            </div>

            {/* 요구사항 15: 봇 수정 및 각 봇별 별명(Nickname) 설정 */}
            <div className="card">
              <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "14px" }}>
                2. 봇별 별명(Nickname) 및 전략 파라미터 수정 (10대 알고리즘 엔진 연동)
              </h3>
              <div className="settings-grid">
                {bots.map((b) => {
                  const form = botEditForms[b.bot_id] || {
                    nickname: b.nickname,
                    min_volume_krw: b.min_volume_krw,
                    stop_loss_pct: b.stop_loss_pct,
                    take_profit_pct: b.take_profit_pct,
                    config: b.config || {},
                  };

                  const updateField = (field, val) => {
                    setBotEditForms((prev) => ({
                      ...prev,
                      [b.bot_id]: {
                        ...form,
                        [field]: val,
                      },
                    }));
                  };

                  const updateConfigField = (cKey, val) => {
                    setBotEditForms((prev) => ({
                      ...prev,
                      [b.bot_id]: {
                        ...form,
                        config: {
                          ...(form.config || {}),
                          [cKey]: val,
                        },
                      },
                    }));
                  };

                  return (
                    <div
                      key={b.bot_id}
                      style={{
                        background: "#161f33",
                        border: "1px solid #26324d",
                        borderRadius: "12px",
                        padding: "16px",
                      }}
                    >
                      <div style={{ fontWeight: 800, fontSize: "15px", marginBottom: "4px" }}>
                        {b.name}
                      </div>
                      <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "12px" }}>
                        알고리즘 소스: <code>backend/common/algo_lab_service.mjs (STRATEGIES.{b.bot_id})</code>
                      </div>

                      <div className="form-row">
                        <label>봇 별명 (Nickname)</label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="봇 별명을 입력하세요"
                          value={form.nickname ?? ""}
                          onChange={(e) => updateField("nickname", e.target.value)}
                        />
                      </div>

                      <div className="form-row">
                        <label>
                          최소 거래대금 유동성 필터 (min_volume_krw):{" "}
                          <strong style={{ color: "#a5b4fc" }}>
                            {formatWithCommas(form.min_volume_krw)
                              ? `${formatWithCommas(form.min_volume_krw)}원`
                              : "미설정"}
                          </strong>
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          className="form-input"
                          placeholder="최소 거래대금 입력"
                          value={formatWithCommas(form.min_volume_krw)}
                          onChange={(e) =>
                            updateField("min_volume_krw", parseNumericInput(e.target.value))
                          }
                        />
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                        <div className="form-row">
                          <label>손절 기준 (%)</label>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            placeholder="손절 %"
                            value={form.stop_loss_pct ?? ""}
                            onChange={(e) =>
                              updateField(
                                "stop_loss_pct",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                        <div className="form-row">
                          <label>익절 기준 (%)</label>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            placeholder="익절 %"
                            value={form.take_profit_pct ?? ""}
                            onChange={(e) =>
                              updateField(
                                "take_profit_pct",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      </div>

                      {(() => {
                        const defaultRatio =
                          b.bot_id === "bot_volatility"
                            ? 0.3
                            : b.bot_id === "bot_dual_momentum"
                            ? 0.35
                            : 0.45;
                        const rawOrderRatio = form.config?.order_ratio;
                        const ratioPctVal =
                          rawOrderRatio === "" || rawOrderRatio === undefined || rawOrderRatio === null
                            ? Math.round(defaultRatio * 100)
                            : Number(rawOrderRatio) <= 1
                            ? Math.round(Number(rawOrderRatio) * 100)
                            : Number(rawOrderRatio);
                        const allocKrw = Math.floor(Number(b.allocated_capital || 0));
                        const rawPreviewKrw = Math.floor(allocKrw * (Number(ratioPctVal || 0) / 100));
                        const effectivePreviewKrw =
                          allocKrw >= 5000 && rawPreviewKrw < 5000 ? 5000 : rawPreviewKrw;

                        return (
                          <div className="form-row">
                            <label>
                              1회 매수 비중 (10% ~ 100%) → 1회 주문 예상액:{" "}
                              <strong style={{ color: "#38bdf8" }}>
                                {effectivePreviewKrw.toLocaleString("ko-KR")}원
                              </strong>
                              {allocKrw >= 5000 && rawPreviewKrw < 5000 && (
                                <span style={{ color: "#fbbf24", fontSize: "11px", marginLeft: "4px" }}>
                                  (최소주문 5,000원 자동적용)
                                </span>
                              )}
                            </label>
                            <input
                              type="number"
                              step="5"
                              min="10"
                              max="100"
                              className="form-input"
                              placeholder="1회 매수 비중(%) 입력 (예: 50, 100)"
                              value={
                                rawOrderRatio === ""
                                  ? ""
                                  : ratioPctVal
                              }
                              onChange={(e) => {
                                if (e.target.value === "") {
                                  updateConfigField("order_ratio", "");
                                } else {
                                  const pct = Math.min(100, Math.max(1, Number(e.target.value)));
                                  updateConfigField("order_ratio", Number((pct / 100).toFixed(4)));
                                }
                              }}
                            />
                          </div>
                        );
                      })()}

                      {b.bot_id === "bot_volatility" && (
                        <div className="form-row">
                          <label>변동성 돌파 K 계수 (0.1 ~ 0.9 / 추천: 0.4)</label>
                          <input
                            type="number"
                            step="0.05"
                            className="form-input"
                            placeholder="K 계수 입력 (추천: 0.4)"
                            value={form.config?.k_value ?? ""}
                            onChange={(e) =>
                              updateConfigField(
                                "k_value",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      )}

                      {b.bot_id === "bot_dual_momentum" && (
                        <div className="form-row">
                          <label>절대 모멘텀 최소 수익률 기준 (% / 추천: 1.5%)</label>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            placeholder="최소 수익률(%) 입력 (추천: 1.5)"
                            value={form.config?.abs_momentum_threshold_pct ?? ""}
                            onChange={(e) =>
                              updateConfigField(
                                "abs_momentum_threshold_pct",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      )}

                      {b.bot_id === "bot_bollinger_reversal" && (
                        <div className="form-row">
                          <label>볼린저 밴드 표준편차 배수 (σ / 추천: 2.0)</label>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            placeholder="표준편차 배수 입력 (추천: 2.0)"
                            value={form.config?.bb_std ?? ""}
                            onChange={(e) =>
                              updateConfigField(
                                "bb_std",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      )}

                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ width: "100%", marginTop: "6px" }}
                        onClick={() => handleSaveBotConfig(b.bot_id)}
                      >
                        [{form.nickname || b.name}] 설정 저장
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 3. 보안 및 입장 코드(Gate Code) 설정 */}
            <div className="card" style={{ marginBottom: "20px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "14px",
                  flexWrap: "wrap",
                  gap: "10px",
                }}
              >
                <div>
                  <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                    3. 보안 및 입장 코드(Gate Code) 설정
                  </h3>
                  <p style={{ margin: "4px 0 0 0", fontSize: "12.5px", color: "#94a3b8" }}>
                    시스템 초기 진입 시 요구되는 개인 전용 보안 입장 코드를 조회하고 변경합니다. (기본값: <code>stock</code>)
                  </p>
                </div>
                {entryCodeSetting && (
                  <span
                    style={{
                      padding: "4px 10px",
                      borderRadius: "8px",
                      fontSize: "12px",
                      fontWeight: 600,
                      background: "rgba(56, 189, 248, 0.15)",
                      color: "#38bdf8",
                      border: "1px solid rgba(56, 189, 248, 0.3)",
                    }}
                  >
                    현재 적용 코드: {showEntryCode ? entryCodeSetting : "••••••••"}
                  </span>
                )}
              </div>

              <form onSubmit={handleSaveEntryCode} style={{ maxWidth: "600px" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: "12px",
                    marginBottom: "12px",
                  }}
                >
                  <div className="form-row" style={{ margin: 0 }}>
                    <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>새 입장 코드</span>
                      <button
                        type="button"
                        onClick={() => setShowEntryCode(!showEntryCode)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#94a3b8",
                          fontSize: "11px",
                          cursor: "pointer",
                          padding: "0 2px",
                        }}
                      >
                        {showEntryCode ? "숨기기 🙈" : "보기 👁️"}
                      </button>
                    </label>
                    <input
                      type={showEntryCode ? "text" : "password"}
                      className="form-input"
                      placeholder="새 입장 코드 입력"
                      value={newEntryCodeInput}
                      onChange={(e) => setNewEntryCodeInput(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-row" style={{ margin: 0 }}>
                    <label>새 입장 코드 확인</label>
                    <input
                      type={showEntryCode ? "text" : "password"}
                      className="form-input"
                      placeholder="한 번 더 입력"
                      value={newEntryCodeConfirm}
                      onChange={(e) => setNewEntryCodeConfirm(e.target.value)}
                    />
                  </div>
                </div>

                {entryCodeMsg && (
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: "6px",
                      fontSize: "12.5px",
                      marginBottom: "12px",
                      background:
                        entryCodeMsg.type === "success"
                          ? "rgba(34, 197, 94, 0.15)"
                          : "rgba(239, 68, 68, 0.15)",
                      color: entryCodeMsg.type === "success" ? "#4ade80" : "#fca5a5",
                      border: `1px solid ${
                        entryCodeMsg.type === "success" ? "#22c55e" : "#ef4444"
                      }`,
                    }}
                  >
                    {entryCodeMsg.text}
                  </div>
                )}

                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={entryCodeLoading}
                  >
                    {entryCodeLoading ? "변경 저장 중..." : "🔑 입장 코드 변경 저장"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => {
                      setNewEntryCodeInput("stock");
                      setNewEntryCodeConfirm("stock");
                    }}
                    title="기본값 stock으로 입력란을 채웁니다."
                  >
                    기본값(stock)으로 입력
                  </button>
                </div>
              </form>
            </div>

            {/* 요구사항 13: 데이터 마이그레이션(JSON 내보내기) 및 복원(JSON 파일 읽기) */}
            <div className="card">
              <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "8px" }}>
                4. 데이터 마이그레이션 및 복원 (JSON)
              </h3>
              <p style={{ fontSize: "13px", color: "#94a3b8", marginBottom: "16px" }}>
                SQLite 데이터베이스의 전체 데이터(봇 설정, 거래 내역, 포지션, 시스템 설정)를 JSON 파일로 백업(마이그레이션)하거나, JSON 파일을 읽어 복원합니다.
              </p>
              <div className="btn-group">
                <button type="button" className="btn btn-primary" onClick={handleExportJson}>
                  ⬇ JSON 마이그레이션 파일 내보내기 (Export)
                </button>
                <label className="btn btn-outline" style={{ display: "inline-flex", alignItems: "center" }}>
                  ⬆ JSON 파일 읽어서 데이터 복원 (Import)
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: "none" }}
                    onChange={handleImportJsonFile}
                  />
                </label>
              </div>
            </div>

            {/* 요구사항: 웹푸시 알림 설정 및 테스트 */}
            <div className="card" style={{ marginTop: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "10px" }}>
                <div>
                  <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                    5. 실시간 웹푸시 알림 설정 (Web Push)
                  </h3>
                  <p style={{ margin: "4px 0 0 0", fontSize: "12.5px", color: "#94a3b8" }}>
                    AI 뉴스 분석이 완료되면 다른 작업 중이거나 브라우저가 최소화되어 있어도 <strong>'ai 분석이 완료되었습니다'</strong> 브라우저 푸시 알림을 즉시 수신합니다.
                  </p>
                </div>
                <span
                  style={{
                    padding: "4px 10px",
                    borderRadius: "8px",
                    fontSize: "12px",
                    fontWeight: 600,
                    background:
                      notificationPermission === "granted"
                        ? "rgba(34, 197, 94, 0.15)"
                        : notificationPermission === "denied"
                        ? "rgba(239, 68, 68, 0.15)"
                        : "rgba(234, 179, 8, 0.15)",
                    color:
                      notificationPermission === "granted"
                        ? "#4ade80"
                        : notificationPermission === "denied"
                        ? "#f87171"
                        : "#facc15",
                    border: `1px solid ${
                      notificationPermission === "granted"
                        ? "rgba(34, 197, 94, 0.3)"
                        : notificationPermission === "denied"
                        ? "rgba(239, 68, 68, 0.3)"
                        : "rgba(234, 179, 8, 0.3)"
                    }`,
                  }}
                >
                  권한 상태:{" "}
                  {notificationPermission === "granted"
                    ? "🔔 허용됨 (정상 작동 중)"
                    : notificationPermission === "denied"
                    ? "🚫 차단됨 (브라우저 설정 변경 필요)"
                    : "⏳ 미설정 (클릭하여 권한 허용 필요)"}
                </span>
              </div>
              <div className="btn-group" style={{ marginTop: "12px" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => registerAndSubscribePush(true)}
                  disabled={notificationPermission === "granted"}
                >
                  {notificationPermission === "granted" ? "✓ 웹푸시 알림 허용 완료" : "🔔 웹푸시 알림 권한 허용 및 활성화"}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={async () => {
                    showWebPushNotification("AI 뉴스 분석 완료", "ai 분석이 완료되었습니다", {
                      tag: `push-test-settings-${Date.now()}`,
                    });
                    try {
                      await fetch(`${API_BASE}/api/push/test`, { method: "POST" });
                    } catch (e) {}
                  }}
                >
                  📢 테스트 웹푸시 발송
                </button>
              </div>
            </div>

            {/* 요구사항: 프로젝트 버전 및 변경 이력 (History) 정보 카드 */}
            <div className="card" style={{ marginTop: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "10px" }}>
                <div>
                  <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                    6. 시스템 버전 및 변경 이력 관리 (Version & History)
                  </h3>
                  <p style={{ margin: "4px 0 0 0", fontSize: "12.5px", color: "#94a3b8" }}>
                    autoCoinTrade는 <code>0.0.1</code>부터 시작하여 커밋 1건당 1씩 증가하는 <code>0.0.X</code> 버전 규칙을 엄격하게 유지합니다.
                  </p>
                </div>
                <span className="version-pill-badge" style={{ padding: "6px 14px", fontSize: "12.5px" }}>
                  현재 버전: v{appVersion}
                </span>
              </div>
              <div style={{ background: "rgba(15, 23, 42, 0.6)", padding: "14px 18px", borderRadius: "10px", border: "1px solid rgba(255, 255, 255, 0.06)", marginBottom: "14px", fontSize: "13px", color: "#cbd5e1" }}>
                <div>• <strong>현재 프로젝트 버전</strong>: <span style={{ color: "#38bdf8", fontWeight: 700 }}>v{appVersion}</span></div>
                <div style={{ marginTop: "4px" }}>• <strong>버전 정책</strong>: 별다른 지침이 없을 경우 <code>0.0.숫자</code> 증가 형태 유지 (Git Commit 1건당 1씩 증가)</div>
                <div style={{ marginTop: "4px" }}>• <strong>형상 관리 문서</strong>: <code>history.md</code>, <code>package.json</code> 및 웹 UI 동기화 완료</div>
              </div>
              <div className="btn-group">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={openHistoryModal}
                  style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}
                >
                  <span>📜</span>
                  <span>버전별 전체 수정내역(history.md) 열람</span>
                </button>
              </div>
            </div>
          </div>
        )}
        {/* 법적 면책 조항 (Legal Disclaimer Footer) */}
        <footer
          style={{
            marginTop: "40px",
            padding: "20px 16px",
            borderTop: "1px solid rgba(255, 255, 255, 0.08)",
            textAlign: "center",
            color: "#64748b",
            fontSize: "12px",
            lineHeight: "1.6",
          }}
        >
          <div style={{ maxWidth: "800px", margin: "0 auto" }}>
            <div style={{ marginBottom: "6px" }}>
              <span style={{ fontWeight: 700, color: "#94a3b8" }}>autoCoinTrade v{appVersion}</span>
              {" · "}
              <span
                style={{ color: "#38bdf8", cursor: "pointer", textDecoration: "underline" }}
                onClick={openHistoryModal}
              >
                📜 버전별 수정내역(history.md) 확인
              </span>
            </div>
            <span style={{ fontWeight: 600, color: "#94a3b8" }}>⚖️ 법적 면책 조항 (Disclaimer):</span><br />
            본 프로그램은 오픈소스 소프트웨어 및 알고리즘 연구 목적의 도구일 뿐, 수익을 보장하거나 특정 종목의 매수를 권유하지 않습니다. 모든 실전 투자의 책임은 사용자 본인에게 있습니다.
          </div>
        </footer>
      </main>

      {/* 인앱 웹푸시 토스트 팝업 */}
      {pushToast.show && (
        <div
          style={{
            position: "fixed",
            top: "24px",
            right: "24px",
            zIndex: 99999,
            background: "linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.95))",
            border: "1px solid rgba(56, 189, 248, 0.5)",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 0 15px rgba(56, 189, 248, 0.3)",
            borderRadius: "12px",
            padding: "14px 18px",
            color: "#f8fafc",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            backdropFilter: "blur(10px)",
            animation: "fadeInSlide 0.3s ease-out",
            cursor: "pointer",
          }}
          onClick={() => {
            setActiveMenu("news");
            setPushToast((p) => ({ ...p, show: false }));
          }}
        >
          <span style={{ fontSize: "24px" }}>🔔</span>
          <div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#38bdf8" }}>
              {pushToast.title}
            </div>
            <div style={{ fontSize: "13px", color: "#e2e8f0", marginTop: "2px" }}>
              {pushToast.message}
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPushToast((p) => ({ ...p, show: false }));
            }}
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              fontSize: "16px",
              cursor: "pointer",
              marginLeft: "8px",
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* 요구사항 20, 21: 거래 시작/중지 동작 알림 및 잔고 0 이하 거래 중지 알림 Modal Popup */}
      {modalInfo.open && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div
              className="modal-title"
              style={{
                color:
                  modalInfo.type === "danger"
                    ? "#f87171"
                    : modalInfo.type === "success"
                    ? "#4ade80"
                    : "#a5b4fc",
              }}
            >
              {modalInfo.title}
            </div>
            <div className="modal-body" style={{ whiteSpace: "pre-line" }}>
              {modalInfo.message}
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={closeModal}>
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 버전별 변경 이력 (history.md) Modal Popup */}
      {renderHistoryModal()}
    </div>
  );
}

