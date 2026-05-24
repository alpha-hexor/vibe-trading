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

  scoreOpportunity(report) {
    const indicator = report.indicators;
    const momentum = Math.abs(safeNumber(indicator.macdHistogram));
    const rsiDistance = indicator.rsi14 === null ? 0 : Math.abs(indicator.rsi14 - 50) / 50;
    const trendWeight =
      indicator.trendBias === "bullish" || indicator.trendBias === "bearish" ? 1 : 0.35;
    const changeWeight = Math.min(Math.abs(report.priceChange24hPct) / 10, 1);
    const volumeWeight = Math.min(Math.log10(report.volume24h + 1) / 6, 1);
    return Number(
      (10 * (0.30 * trendWeight + 0.25 * momentum + 0.20 * rsiDistance + 0.15 * changeWeight + 0.10 * volumeWeight)).toFixed(2),
    );
  }

  async buildSymbolReport(symbol) {
    const [snapshot, usdInrRate] = await Promise.all([
      this.getMarketSnapshot(),
      this.getUsdInrRate(),
    ]);

    const normalizedSymbol = await this.resolveSymbol(symbol);
    const [ticker, depth, candles] = await Promise.all([
      this.getTicker24h(normalizedSymbol),
      this.getDepth(normalizedSymbol),
      this.getCandles(normalizedSymbol, { intervalMinutes: 15, lookbackHours: 18 }),
    ]);

    const marketRow = snapshot.find((item) => item.symbol === normalizedSymbol);
    if (!marketRow || !marketRow.market) {
      throw new Error(`Unknown or unavailable futures symbol: ${normalizedSymbol}`);
    }

    const normalizedCandles = normalizeCandles(candles);
    const indicators = summarizeIndicators(normalizedCandles);
    const markPriceUsd = safeNumber(marketRow.market.markPrice);
    const indexPriceUsd = safeNumber(marketRow.market.indexPrice);
    const fundingRate = safeNumber(marketRow.market.fundingRate);
    const markPriceInr = Number((markPriceUsd * usdInrRate).toFixed(2));

    const report = {
      symbol: normalizedSymbol,
      baseAsset: marketRow.baseAsset,
      quoteAsset: marketRow.quoteAsset,
      usdtInrRate: usdInrRate,
      markPriceUsd,
      markPriceInr,
      indexPriceUsd,
      fundingRate,
      fundingRatePct: Number((fundingRate * 100).toFixed(4)),
      priceChange24hPct: safeNumber(ticker.priceChangePercent),
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
      candles15m: normalizedCandles,
      indicators,
    };

    return {
      ...report,
      opportunityScore: this.scoreOpportunity(report),
      suggestedDirection:
        indicators.trendBias === "bullish"
          ? "LONG"
          : indicators.trendBias === "bearish"
            ? "SHORT"
            : "WAIT",
    };
  }

  async scanMarket({ limit = 8 } = {}) {
    const snapshot = await this.getMarketSnapshot();
    const liquid = snapshot.filter((row) => row.market);
    const shortlist = liquid
      .sort((a, b) => safeNumber(b.lotSize) - safeNumber(a.lotSize))
      .slice(0, Math.max(limit * 3, 15));

    const reports = [];
    for (const row of shortlist) {
      try {
        reports.push(await this.buildSymbolReport(row.symbol));
      } catch {
        continue;
      }
    }

    return reports
      .filter((item) => item.suggestedDirection !== "WAIT")
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
