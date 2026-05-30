export function buildSystemPrompt() {
  return `You are Claude Future, a sharp crypto futures trading assistant running inside a chat interface.
The user expects direct, actionable analysis — no filler, no disclaimers beyond what is necessary.

Identity:
- You operate inside a terminal chat application (and optionally a web chatbot).
- You are not connected to the user's exchange account and cannot place or manage live orders.
- This tool is for research and planning only.

When given market data, reason through this chain before answering:
1. TREND     — What do the EMAs (9/21/50) say on each timeframe? Are they stacked bullishly or bearishly?
2. MOMENTUM  — Does RSI confirm trend strength (>55 bull, <45 bear)? Is MACD histogram growing or fading?
3. CONFLUENCE — Do 4h, 1h, and 15m all agree? More agreement = higher conviction. OBV slope and Bollinger %B add weight.
4. RISK      — What is the ATR-based stop distance? Is it reasonable (<2% for most setups)? Where is support/resistance?
5. FUNDING   — Is funding rate extreme? Extreme positive (>0.1%) = avoid new longs; extreme negative (<-0.05%) = avoid new shorts.
6. CONVICTION — Weigh all of the above. If fewer than 3 signals agree, say WAIT and explain exactly why.

When recommending a trade, always state:
- Direction (LONG / SHORT / WAIT)
- Entry zone (a price range, not a single price)
- Stop loss level and the reason for it (usually ATR-based or below/above key structure)
- First target (TP1) and second target (TP2) with rough risk:reward ratio
- Conviction level: low / medium / high, and one sentence explaining it
- Timeframe alignment: aligned / partial / conflicted

When the user is asking casually (market chat, account sizing, general questions), respond naturally and conversationally.
Never claim to place orders. Never imply guaranteed profit.
Be honest when data is insufficient — say so plainly and suggest what to look for instead.

Operating rules:
- Ground every claim in the provided market context. If data is missing, say so.
- Prefer concrete numbers over vague language.
- If the user mentions INR capital or a daily profit target, reason about position sizing, leverage, and downside risk in plain numbers.
- Keep continuity with earlier session context when it is provided.
- When the user is casually greeting you, respond naturally and briefly.
- If the user asks for execution or account actions, clearly state this CLI is research-only.

Command awareness:
- The terminal supports slash commands for market lookup, scans, symbol reports, and daily planning.
- When the user asks a free-form question, synthesize the supplied context into the best possible answer.
`;
}

/**
 * Formats multi-timeframe symbol data as a readable text block.
 * This lets Qwen3 reason like a trader reading a chart
 * rather than parsing raw JSON, which reduces hallucination.
 */
function formatSymbolPrompt(report) {
  const fmt = (v, d = 4) => (v === null || v === undefined ? "n/a" : Number(v).toFixed(d));
  const fmtBias = (b) => b ?? "n/a";

  const tf4h = report.indicators4h;
  const tf1h = report.indicators1h;
  const tf15m = report.indicators15m ?? report.indicators;

  const pivots = report.dailyPivots;
  const lines = [
    `Symbol focus: ${report.symbol}`,
    ``,
    `Multi-timeframe indicators:`,
    `  4h  → trend ${fmtBias(tf4h?.trendBias)}  RSI ${fmt(tf4h?.rsi14, 1)}  MACD hist ${fmt(tf4h?.macdHistogram, 5)}  StochRSI k=${fmt(tf4h?.stochRsi?.k, 1)} d=${fmt(tf4h?.stochRsi?.d, 1)}  OBV slope ${fmt(tf4h?.obvSlope, 4)}  BB%B ${fmt(tf4h?.bb?.percentB, 2)}`,
    `  1h  → trend ${fmtBias(tf1h?.trendBias)}  RSI ${fmt(tf1h?.rsi14, 1)}  MACD hist ${fmt(tf1h?.macdHistogram, 5)}  StochRSI k=${fmt(tf1h?.stochRsi?.k, 1)} d=${fmt(tf1h?.stochRsi?.d, 1)}  OBV slope ${fmt(tf1h?.obvSlope, 4)}  BB%B ${fmt(tf1h?.bb?.percentB, 2)}`,
    `  15m → trend ${fmtBias(tf15m?.trendBias)}  RSI ${fmt(tf15m?.rsi14, 1)}  MACD hist ${fmt(tf15m?.macdHistogram, 5)}  StochRSI k=${fmt(tf15m?.stochRsi?.k, 1)} d=${fmt(tf15m?.stochRsi?.d, 1)}  OBV slope ${fmt(tf15m?.obvSlope, 4)}  BB%B ${fmt(tf15m?.bb?.percentB, 2)}`,
    ``,
    `Price: $${fmt(report.markPriceUsd, 4)}  INR: ₹${fmt(report.markPriceInr, 2)}`,
    `24h change: ${fmt(report.priceChange24hPct, 2)}%  High: $${fmt(report.high24hUsd, 4)}  Low: $${fmt(report.low24hUsd, 4)}`,
    `Funding rate: ${fmt(report.fundingRatePct, 4)}%  (${report.fundingSignal ?? "n/a"})`,
    `VWPM(10): $${fmt(tf15m?.vwpm, 4)}  (price ${report.markPriceUsd > tf15m?.vwpm ? "above" : "below"} VWPM → ${report.markPriceUsd > tf15m?.vwpm ? "buyers in control" : "sellers in control"})`,
    `ATR(14): ${fmt(tf15m?.atr14, 5)}  BB width: ${fmt(tf15m?.bb?.width, 5)}`,
    `Order book imbalance: ${fmt(report.orderBookImbalance, 3)}  (>0 = bid heavy, <0 = ask heavy)`,
    `Relative strength vs BTC: ${fmt(report.relativeStrengthVsBtc, 3)}  (>1 = outperforming BTC)`,
    `Max leverage: ${report.maxLeverage}x  Confluence score: ${report.opportunityScore}/10`,
    ``,
    pivots
      ? `Daily pivot points (hard S/R levels):  PP $${fmt(pivots.pp, 4)}  R1 $${fmt(pivots.r1, 4)}  R2 $${fmt(pivots.r2, 4)}  R3 $${fmt(pivots.r3, 4)}  S1 $${fmt(pivots.s1, 4)}  S2 $${fmt(pivots.s2, 4)}  S3 $${fmt(pivots.s3, 4)}`
      : `Daily pivot points: n/a`,
    `15m support: $${fmt(tf15m?.support, 4)}  15m resistance: $${fmt(tf15m?.resistance, 4)}`,
  ];

  return lines.join("\n");
}

export function buildUserPrompt({
  question,
  marketOverview,
  scans,
  symbolReport,
  planContext,
  sessionMemory,
}) {
  const sections = [
    `User message:\n${question}`,
    sessionMemory
      ? `Session context:\n${JSON.stringify(sessionMemory, null, 2)}`
      : null,
    marketOverview
      ? `Live market snapshot:\n${JSON.stringify(marketOverview, null, 2)}`
      : null,
    scans
      ? `Scanned setups (ranked by confluence score):\n${JSON.stringify(scans.map((s) => ({
          symbol: s.symbol,
          direction: s.suggestedDirection,
          score: s.opportunityScore,
          priceUsd: s.markPriceUsd,
          priceInr: s.markPriceInr,
          trend4h: s.indicators4h?.trendBias,
          rsi4h: s.indicators4h?.rsi14?.toFixed(1),
          macdHist4h: s.indicators4h?.macdHistogram?.toFixed(5),
          trend1h: s.indicators1h?.trendBias,
          rsi1h: s.indicators1h?.rsi14?.toFixed(1),
          macdHist1h: s.indicators1h?.macdHistogram?.toFixed(5),
          trend15m: (s.indicators15m ?? s.indicators)?.trendBias,
          rsi15m: (s.indicators15m ?? s.indicators)?.rsi14?.toFixed(1),
          macdHist15m: (s.indicators15m ?? s.indicators)?.macdHistogram?.toFixed(5),
          atr15m: (s.indicators15m ?? s.indicators)?.atr14,
          support15m: (s.indicators15m ?? s.indicators)?.support,
          resistance15m: (s.indicators15m ?? s.indicators)?.resistance,
          pivotPP: s.dailyPivots?.pp,
          fundingPct: s.fundingRatePct,
          fundingSignal: s.fundingSignal,
          relativeStrength: s.relativeStrengthVsBtc?.toFixed(3),
          priceChange24h: s.priceChange24hPct,
        })), null, 2)}`
      : null,
    symbolReport ? formatSymbolPrompt(symbolReport) : null,
    planContext
      ? `Trading plan context:\n${JSON.stringify(planContext, null, 2)}`
      : null,
  ].filter(Boolean);

  return sections.join("\n\n---\n\n");
}
