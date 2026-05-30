import { summarizeIndicators, normalizeCandles } from "./indicators.js";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  "x-platform-id": "PRO_INR_FUTURES",
  "x-request-id": "claude-future-cli",
};

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatCoinSwitchSymbol(symbol) {
  return symbol.toUpperCase().endsWith("USDT")
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}USDT`;
}

/**
 * Order book imbalance: ratio of bid vs ask volume in the top N levels.
 * Range: -1 (all asks) to +1 (all bids).
 * >0.3 → buy-side dominance (LONG signal); <-0.3 → sell-side dominance (SHORT signal).
 */
function orderBookImbalance(asks, bids, levels = 5) {
  if (!Array.isArray(asks) || !Array.isArray(bids)) return null;
  const bidVol = bids.slice(0, levels).reduce((s, row) => s + safeNumber(row[1]), 0);
  const askVol = asks.slice(0, levels).reduce((s, row) => s + safeNumber(row[1]), 0);
  const total = bidVol + askVol;
  if (total === 0) return null;
  return Number(((bidVol - askVol) / total).toFixed(4));
}

/**
 * Categorise funding rate into a human-readable signal.
 * Feeds directly into the Qwen3 prompt for context-aware reasoning.
 */
function fundingSignal(fundingRatePct) {
  if (fundingRatePct > 0.1) return "extreme_long";
  if (fundingRatePct > 0.05) return "long";
  if (fundingRatePct < -0.05) return "extreme_short";
  if (fundingRatePct < -0.02) return "short";
  return "neutral";
}

export class CoinSwitchFuturesClient {
  constructor({ exchange = "BYBIT" } = {}) {
    this.baseUrl = "https://coinswitch.co/pro/api/v1/futures";
    this.exchange = exchange;
    this.headers = DEFAULT_HEADERS;
  }

  async request(path, query = undefined) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      headers: this.headers,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`CoinSwitch request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  async getUsdInrRate() {
    const json = await this.request("/usdt-inr-rate");
    return safeNumber(json?.data?.rate, 90);
  }

  async getSymbolList() {
    const json = await this.request("/assets", { exchange: this.exchange });
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .map((item) => {
        const market = item?.market ?? {};
        const clientMarket = market?.client_market ?? {};
        if (!clientMarket.enable || !market.broker_market_symbol) {
          return null;
        }
        return {
          symbol: market.broker_market_symbol,
          baseAsset: String(market.base_asset_symbol ?? "").toUpperCase(),
          quoteAsset: String(market.quote_asset_symbol ?? "").toUpperCase(),
          minLeverage: safeNumber(market.min_client_leverage, 1),
          maxLeverage: safeNumber(market.max_client_leverage, 1),
          makerFee: safeNumber(clientMarket.maker_fee, 0),
          takerFee: safeNumber(clientMarket.taker_fee, 0),
          lotSize: safeNumber(clientMarket.lot_size, 0),
          pricePrecision: clientMarket.limit_precision ?? null,
          quantityPrecision: clientMarket.base_asset_precision ?? null,
        };
      })
      .filter(Boolean);
  }

  async getMarkPrices() {
    const json = await this.request("/markPrice/all-pairs", { exchange: this.exchange });
    const data = json?.data ?? {};
    const prices = new Map();
    for (const symbolData of Object.values(data)) {
      prices.set(`${symbolData.base_asset}${symbolData.quote_asset}`, {
        markPrice: safeNumber(symbolData.mark_price),
        indexPrice: safeNumber(symbolData.index_price),
        fundingRate: safeNumber(symbolData.funding_rate),
        nextFunding: symbolData.next_funding_timestamp ?? null,
        timestamp: symbolData.mark_price_timestamp ?? null,
      });
    }
    return prices;
  }

  async getRiskTiers() {
    const json = await this.request("/mmr-tiers");
    const data = json?.data ?? {};
    const tiers = new Map();
    for (const [symbol, levels] of Object.entries(data)) {
      tiers.set(
        symbol,
        (levels ?? []).map((tier) => ({
          tier: safeNumber(tier.tier_level),
          initialMargin: safeNumber(tier.initial_margin),
          maintenanceMargin: safeNumber(tier.maintenance_margin),
          maxLeverage: safeNumber(tier.max_leverage),
          riskLimit: safeNumber(tier.risk_limit_value),
        })),
      );
    }
    return tiers;
  }

  async getMarketSnapshot() {
    const [symbols, prices, tiers] = await Promise.all([
      this.getSymbolList(),
      this.getMarkPrices(),
      this.getRiskTiers(),
    ]);

    return symbols.map((symbol) => ({
      ...symbol,
      market: prices.get(symbol.symbol) ?? null,
      risk: tiers.get(symbol.symbol) ?? [],
    }));
  }

  async resolveSymbol(inputSymbol) {
    const snapshot = await this.getMarketSnapshot();
    const requested = String(inputSymbol ?? "").trim().toUpperCase();
    if (!requested) {
      throw new Error("Symbol is required");
    }

    const normalized = formatCoinSwitchSymbol(requested);
    const exact =
      snapshot.find((item) => item.symbol === requested) ??
      snapshot.find((item) => item.symbol === normalized);
    if (exact) {
      return exact.symbol;
    }

    const base = requested.replace(/USDT$/i, "");
    const byBase = snapshot.find(
      (item) =>
        item.baseAsset === base ||
        item.symbol === `${base}USDT` ||
        item.symbol.startsWith(base),
    );
    if (byBase) {
      return byBase.symbol;
    }

    throw new Error(`Could not resolve symbol: ${inputSymbol}`);
  }

  async getTicker24h(symbol) {
    const base = symbol.replace(/USDT$/i, "").toLowerCase();
    const json = await this.request(
      `/ticker/24hr?symbol=${base},usdt&exchange=[%22${this.exchange}%22]`,
    );
    return json?.data?.[this.exchange] ?? {};
  }

  async getDepth(symbol) {
    const base = symbol.replace(/USDT$/i, "").toLowerCase();
    const json = await this.request(`/depth?symbol=${base},usdt&exchange=${this.exchange}`);
    return {
      asks: json?.data?.ask ?? [],
      bids: json?.data?.bids ?? [],
    };
  }

  async getCandles(symbol, { intervalMinutes = 15, lookbackHours = 12 } = {}) {
    const toTime = String(Date.now());
    const fromTime = String(Date.now() - lookbackHours * 60 * 60 * 1000);
    const targetSymbol = formatCoinSwitchSymbol(symbol);
    const json = await this.request(
      `/getDataForCandlestick?to_time=${toTime}&from_time=${fromTime}&symbol=${targetSymbol}&c_duration=${intervalMinutes}&exchange=bybit&market_type=FUTURES`,
    );
    return Array.isArray(json?.result) ? json.result : [];
  }

  /**
   * Confluence-based opportunity scorer (0–10).
   * Each independent signal adds to the score. 10/10 = all signals aligned.
   * Much more reliable than the old linear weighted sum.
   */
  scoreOpportunity(report) {
    const ind = report.indicators15m ?? report.indicators;
    if (!ind) return 0;

    let score = 0;
    let maxScore = 0;

    // 1. EMA stack alignment (3 checks, weight 3)
    maxScore += 3;
    const { ema9, ema21, ema50 } = ind;
    if (ema9 !== null && ema21 !== null && ema50 !== null) {
      if (ema9 > ema21 && ema21 > ema50) score += 3;       // full bullish stack
      else if (ema9 < ema21 && ema21 < ema50) score += 3;  // full bearish stack
      else if (ema9 > ema21 || ema21 > ema50) score += 1;  // partial
    }

    // 2. RSI in conviction zone
    maxScore += 2;
    if (ind.rsi14 !== null) {
      if (ind.rsi14 >= 52 && ind.rsi14 <= 68) score += 2;  // healthy bull momentum
      else if (ind.rsi14 >= 32 && ind.rsi14 <= 48) score += 2;  // healthy bear momentum
      else if (ind.rsi14 > 48 && ind.rsi14 < 52) score += 0;    // neutral — no edge
    }

    // 3. MACD histogram direction
    maxScore += 1;
    if (ind.macdHistogram !== null && ind.macdHistogram !== 0) score += 1;

    // 4. OBV slope confirming direction
    maxScore += 1;
    if (ind.obvSlope !== null && Math.abs(ind.obvSlope) > 0.02) score += 1;

    // 5. Bollinger %B extremes
    maxScore += 1;
    if (ind.bb?.percentB !== null) {
      if (ind.bb.percentB > 0.6 || ind.bb.percentB < 0.4) score += 1;
    }

    // 6. Multi-timeframe alignment bonus
    maxScore += 2;
    const bias15m = ind.trendBias;
    const bias1h = report.indicators1h?.trendBias;
    const bias4h = report.indicators4h?.trendBias;
    const aligned = [bias4h, bias1h, bias15m].filter(Boolean);
    const dominant = aligned.filter((b) => b === bias15m).length;
    if (dominant === 3) score += 2;
    else if (dominant === 2) score += 1;

    // Normalise to 0–10
    return Number(((score / maxScore) * 10).toFixed(2));
  }

  async buildSymbolReport(symbol, { btcPriceChange24h = null } = {}) {
    const [snapshot, usdInrRate] = await Promise.all([
      this.getMarketSnapshot(),
      this.getUsdInrRate(),
    ]);

    const normalizedSymbol = await this.resolveSymbol(symbol);

    // Fetch all data concurrently: 4 timeframes + ticker + depth
    const [ticker, depth, candles15m, candles1h, candles4h, candlesDaily] = await Promise.all([
      this.getTicker24h(normalizedSymbol),
      this.getDepth(normalizedSymbol),
      this.getCandles(normalizedSymbol, { intervalMinutes: 15, lookbackHours: 24 }),
      this.getCandles(normalizedSymbol, { intervalMinutes: 60, lookbackHours: 96 }),
      this.getCandles(normalizedSymbol, { intervalMinutes: 240, lookbackHours: 30 * 24 }),
      // Daily candles: fetch last 30 days at 1440m interval for pivot point computation
      this.getCandles(normalizedSymbol, { intervalMinutes: 1440, lookbackHours: 30 * 24 }),
    ]);

    const marketRow = snapshot.find((item) => item.symbol === normalizedSymbol);
    if (!marketRow || !marketRow.market) {
      throw new Error(`Unknown or unavailable futures symbol: ${normalizedSymbol}`);
    }

    // Compute indicators for all three timeframes
    const normalized15m = normalizeCandles(candles15m);
    const normalized1h = normalizeCandles(candles1h);
    const normalized4h = normalizeCandles(candles4h);
    const normalizedDaily = normalizeCandles(candlesDaily);

    const indicators15m = summarizeIndicators(normalized15m);
    const indicators1h = summarizeIndicators(normalized1h);
    const indicators4h = summarizeIndicators(normalized4h);

    // Compute daily pivot points from the most recently completed daily candle.
    // This gives Qwen3 hard, pre-computed support/resistance levels to reason against.
    const { pivotPoints: computePivots } = await import("./indicators.js");
    const lastDailyCandle = normalizedDaily.length >= 2
      ? normalizedDaily[normalizedDaily.length - 2]  // second-to-last = previous completed day
      : normalizedDaily[normalizedDaily.length - 1] ?? null;
    const dailyPivots = computePivots(lastDailyCandle);

    // Use 15m as the primary indicators for backward-compat
    const indicators = indicators15m;

    const markPriceUsd = safeNumber(marketRow.market.markPrice);
    const indexPriceUsd = safeNumber(marketRow.market.indexPrice);
    const fundingRate = safeNumber(marketRow.market.fundingRate);
    const markPriceInr = Number((markPriceUsd * usdInrRate).toFixed(2));
    const fundingRatePct = Number((fundingRate * 100).toFixed(4));
    const priceChange24hPct = safeNumber(ticker.priceChangePercent);

    // Relative strength vs BTC (>1 = outperforming, <1 = underperforming)
    let relativeStrengthVsBtc = null;
    if (btcPriceChange24h !== null && btcPriceChange24h !== 0) {
      relativeStrengthVsBtc = Number((priceChange24hPct / btcPriceChange24h).toFixed(3));
    }

    // Determine suggested direction from MTF alignment
    const biases = [indicators4h.trendBias, indicators1h.trendBias, indicators15m.trendBias];
    const bullCount = biases.filter((b) => b === "bullish").length;
    const bearCount = biases.filter((b) => b === "bearish").length;
    let suggestedDirection = "WAIT";
    if (bullCount >= 2) suggestedDirection = "LONG";
    else if (bearCount >= 2) suggestedDirection = "SHORT";

    const obi = orderBookImbalance(depth.asks, depth.bids, 5);

    const report = {
      symbol: normalizedSymbol,
      baseAsset: marketRow.baseAsset,
      quoteAsset: marketRow.quoteAsset,
      usdtInrRate: usdInrRate,
      markPriceUsd,
      markPriceInr,
      indexPriceUsd,
      fundingRate,
      fundingRatePct,
      fundingSignal: fundingSignal(fundingRatePct),
      priceChange24hPct,
      high24hUsd: safeNumber(ticker.highPrice),
      low24hUsd: safeNumber(ticker.lowPrice),
      volume24h: safeNumber(ticker.volume),
      maxLeverage: safeNumber(marketRow.maxLeverage, 1),
      minLeverage: safeNumber(marketRow.minLeverage, 1),
      lotSize: safeNumber(marketRow.lotSize),
      makerFee: safeNumber(marketRow.makerFee),
      takerFee: safeNumber(marketRow.takerFee),
      riskTiers: marketRow.risk ?? [],
      orderBook: {
        bestAsk: Array.isArray(depth.asks) && depth.asks[0] ? safeNumber(depth.asks[0][0]) : null,
        bestBid: Array.isArray(depth.bids) && depth.bids[0] ? safeNumber(depth.bids[0][0]) : null,
      },
      orderBookImbalance: obi,
      relativeStrengthVsBtc,
      dailyPivots,
      // All three timeframes
      indicators15m,
      indicators1h,
      indicators4h,
      // Legacy field — still 15m for backward compat with monitor/health checks
      indicators,
      candles15m: normalized15m,
      suggestedDirection,
    };

    return {
      ...report,
      opportunityScore: this.scoreOpportunity(report),
    };
  }

  /**
   * Two-phase market scan across all 500+ symbols.
   *
   * Phase 1 (fast, no candle API calls):
   *   - Uses mark prices already in the snapshot
   *   - Filters by minimum absolute 24h price change to find movers
   *   - Picks top candidates by momentum
   *
   * Phase 2 (deep, candle-based):
   *   - Fetches candles + computes full indicators for top 30 candidates
   *   - Applies the confluence scorer
   *   - Returns top N with a clear direction
   */
  async scanMarket({ limit = 20, phase1Candidates = 40 } = {}) {
    // Fetch snapshot + BTC ticker concurrently for relative strength calculation
    const [snapshot, usdInrRate, btcTicker] = await Promise.all([
      this.getMarketSnapshot(),
      this.getUsdInrRate(),
      this.getTicker24h("BTCUSDT").catch(() => null),
    ]);

    // BTC 24h change — used to compute relative strength for every scanned symbol
    const btcPriceChange24h = safeNumber(btcTicker?.priceChangePercent, 0) || null;

    // Phase 1: fast filter from snapshot data (no extra API calls)
    const liquid = snapshot.filter((row) => row.market && safeNumber(row.market.markPrice) > 0);

    // Score Phase 1 quickly using funding + lot size as a proxy for liquidity+activity
    const phase1Scored = liquid
      .map((row) => ({
        symbol: row.symbol,
        markPrice: safeNumber(row.market.markPrice),
        fundingRate: safeNumber(row.market.fundingRate),
        fundingRatePct: Number((safeNumber(row.market.fundingRate) * 100).toFixed(4)),
        lotSize: safeNumber(row.lotSize),
      }))
      // Sort by lot size (proxy for liquidity) to pick active markets
      .sort((a, b) => b.lotSize - a.lotSize)
      .slice(0, Math.max(phase1Candidates, limit * 4));

    // Phase 2: deep analysis with candles (run in parallel, silently skip failures)
    const settled = await Promise.allSettled(
      phase1Scored.map((row) =>
        this.buildSymbolReport(row.symbol, { btcPriceChange24h }),
      ),
    );

    const reports = settled
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((r) => r.suggestedDirection !== "WAIT");

    return reports
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, limit);
  }

  async getMarketOverview({ limit = 10 } = {}) {
    const usdInrRate = await this.getUsdInrRate();
    const snapshot = await this.getMarketSnapshot();
    const rows = snapshot
      .filter((item) => item.market)
      .map((item) => ({
        symbol: item.symbol,
        baseAsset: item.baseAsset,
        markPriceUsd: safeNumber(item.market.markPrice),
        markPriceInr: Number((safeNumber(item.market.markPrice) * usdInrRate).toFixed(2)),
        fundingRatePct: Number((safeNumber(item.market.fundingRate) * 100).toFixed(4)),
        fundingSignal: fundingSignal(Number((safeNumber(item.market.fundingRate) * 100).toFixed(4))),
        maxLeverage: safeNumber(item.maxLeverage, 1),
        lotSize: safeNumber(item.lotSize),
      }))
      .sort((a, b) => b.lotSize - a.lotSize)
      .slice(0, limit);

    return {
      usdtInrRate: usdInrRate,
      symbolCount: snapshot.length,
      rows,
    };
  }
}
