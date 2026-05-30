function last(values) {
  return values.length > 0 ? values[values.length - 1] : null;
}

export function normalizeCandles(candles) {
  const normalized = [];
  for (const candle of candles ?? []) {
    try {
      if (Array.isArray(candle) && candle.length >= 5) {
        normalized.push({
          open: Number(candle[1]),
          high: Number(candle[2]),
          low: Number(candle[3]),
          close: Number(candle[4]),
          volume: Number(candle[5] ?? 0),
        });
      } else if (candle && typeof candle === "object") {
        normalized.push({
          open: Number(candle.open ?? candle.o ?? 0),
          high: Number(candle.high ?? candle.h ?? 0),
          low: Number(candle.low ?? candle.l ?? 0),
          close: Number(candle.close ?? candle.c ?? 0),
          volume: Number(candle.volume ?? candle.v ?? 0),
        });
      }
    } catch {
      continue;
    }
  }
  return normalized.filter(
    (item) =>
      Number.isFinite(item.open) &&
      Number.isFinite(item.high) &&
      Number.isFinite(item.low) &&
      Number.isFinite(item.close) &&
      Number.isFinite(item.volume),
  );
}

export function ema(values, period) {
  if (period <= 0 || values.length < period) {
    return null;
  }
  const multiplier = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) {
    current = (value - current) * multiplier + current;
  }
  return current;
}

export function sma(values, period) {
  if (period <= 0 || values.length < period) {
    return null;
  }
  const window = values.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / period;
}

export function rsi(values, period = 14) {
  if (values.length <= period) {
    return null;
  }
  const gains = [];
  const losses = [];
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    gains.push(Math.max(delta, 0));
    losses.push(Math.max(-delta, 0));
  }

  let avgGain = gains.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < gains.length; i += 1) {
    avgGain = ((avgGain * (period - 1)) + gains[i]) / period;
    avgLoss = ((avgLoss * (period - 1)) + losses[i]) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function atr(candles, period = 14) {
  if (candles.length <= period) {
    return null;
  }

  const ranges = [];
  let previousClose = candles[0].close;
  for (const candle of candles) {
    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    ranges.push(tr);
    previousClose = candle.close;
  }

  let current = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const range of ranges.slice(period)) {
    current = ((current * (period - 1)) + range) / period;
  }
  return current;
}

export function macd(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (values.length < slowPeriod + signalPeriod) {
    return { line: null, signal: null, histogram: null };
  }

  const macdSeries = [];
  for (let end = slowPeriod; end <= values.length; end += 1) {
    const fast = ema(values.slice(0, end), fastPeriod);
    const slow = ema(values.slice(0, end), slowPeriod);
    if (fast !== null && slow !== null) {
      macdSeries.push(fast - slow);
    }
  }

  const line = last(macdSeries);
  const signal = ema(macdSeries, signalPeriod);
  const histogram = line !== null && signal !== null ? line - signal : null;
  return { line, signal, histogram };
}

/**
 * Bollinger Bands — detects volatility squeezes and overbought/oversold price extremes.
 * Narrow width = potential breakout imminent.
 * Price near upper band = overbought context; near lower = oversold.
 */
export function bollingerBands(values, period = 20, stdDevMultiplier = 2) {
  const mid = sma(values, period);
  if (mid === null) {
    return { upper: null, mid: null, lower: null, width: null, percentB: null };
  }
  const slice = values.slice(-period);
  const variance = slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
  const sigma = Math.sqrt(variance);
  const upper = mid + stdDevMultiplier * sigma;
  const lower = mid - stdDevMultiplier * sigma;
  const width = upper - lower;
  const latestClose = last(values);
  const percentB = width > 0 && latestClose !== null ? (latestClose - lower) / width : null;
  return { upper, mid, lower, width, percentB };
}

/**
 * On-Balance Volume — cumulative volume-price flow indicator.
 * OBV trending up while price is flat = accumulation (bullish divergence).
 * OBV trending down while price is flat = distribution (bearish divergence).
 * Returns the final OBV value and the slope over the last `slopePeriod` candles.
 */
export function obv(candles, slopePeriod = 10) {
  if (candles.length < 2) {
    return { value: null, slope: null };
  }

  const obvSeries = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    const vol = candles[i].volume;
    if (curr > prev) {
      obvSeries.push(obvSeries[i - 1] + vol);
    } else if (curr < prev) {
      obvSeries.push(obvSeries[i - 1] - vol);
    } else {
      obvSeries.push(obvSeries[i - 1]);
    }
  }

  const value = last(obvSeries);

  // Slope: compare average of last slopePeriod values vs the period before
  let slope = null;
  if (obvSeries.length >= slopePeriod * 2) {
    const recent = obvSeries.slice(-slopePeriod);
    const prior = obvSeries.slice(-slopePeriod * 2, -slopePeriod);
    const recentAvg = recent.reduce((s, v) => s + v, 0) / slopePeriod;
    const priorAvg = prior.reduce((s, v) => s + v, 0) / slopePeriod;
    slope = priorAvg !== 0 ? (recentAvg - priorAvg) / Math.abs(priorAvg) : 0;
  }

  return { value, slope };
}

/**
 * Stochastic RSI — normalises RSI into a 0-100 oscillator.
 * Much faster at detecting overbought/oversold than plain RSI.
 * k < 20 = oversold (potential long); k > 80 = overbought (potential short).
 */
export function stochRsi(values, rsiPeriod = 14, stochPeriod = 14) {
  if (values.length < rsiPeriod + stochPeriod) {
    return { k: null, d: null };
  }

  // Build a rolling RSI series
  const rsiSeries = [];
  for (let end = rsiPeriod + 1; end <= values.length; end++) {
    const slice = values.slice(end - rsiPeriod - 1, end);
    rsiSeries.push(rsi(slice, rsiPeriod));
  }

  const validRsi = rsiSeries.filter((v) => v !== null);
  if (validRsi.length < stochPeriod) {
    return { k: null, d: null };
  }

  const window = validRsi.slice(-stochPeriod);
  const lowestRsi = Math.min(...window);
  const highestRsi = Math.max(...window);
  const range = highestRsi - lowestRsi;

  if (range === 0) {
    return { k: 50, d: 50 };
  }

  const k = Number((((validRsi[validRsi.length - 1] - lowestRsi) / range) * 100).toFixed(2));
  // D line = 3-period SMA of K (use last 3 stoch windows if available)
  const kValues = [];
  for (let i = Math.max(0, validRsi.length - stochPeriod - 2); i <= validRsi.length - stochPeriod; i++) {
    const w = validRsi.slice(i, i + stochPeriod);
    const lo = Math.min(...w);
    const hi = Math.max(...w);
    const r = hi - lo;
    kValues.push(r === 0 ? 50 : ((validRsi[i + stochPeriod - 1] - lo) / r) * 100);
  }
  const d = kValues.length > 0
    ? Number((kValues.reduce((s, v) => s + v, 0) / kValues.length).toFixed(2))
    : k;

  return { k, d };
}

/**
 * Volume-Weighted Price Momentum (VWPM).
 * If the current price is above VWPM → buyers are in control (bullish).
 * If below → sellers dominate (bearish).
 * Divergence from EMA signals exhaustion or reversal.
 */
export function vwpm(candles, period = 10) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const totalVol = slice.reduce((s, c) => s + c.volume, 0);
  if (totalVol === 0) return null;
  return Number((slice.reduce((s, c) => s + c.close * c.volume, 0) / totalVol).toFixed(8));
}

/**
 * Classic Pivot Points from the most recent completed candle (or daily candle).
 * PP, R1/R2/R3 and S1/S2/S3 give hard price levels for Qwen3 to reason against.
 * These are much more reliable than arbitrary support/resistance from just looking at lows/highs.
 */
export function pivotPoints(candle) {
  if (!candle) return null;
  const { high: h, low: l, close: c } = candle;
  if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) return null;

  const pp = (h + l + c) / 3;
  const r1 = 2 * pp - l;
  const s1 = 2 * pp - h;
  const r2 = pp + (h - l);
  const s2 = pp - (h - l);
  const r3 = h + 2 * (pp - l);
  const s3 = l - 2 * (h - pp);

  return {
    pp: Number(pp.toFixed(8)),
    r1: Number(r1.toFixed(8)),
    r2: Number(r2.toFixed(8)),
    r3: Number(r3.toFixed(8)),
    s1: Number(s1.toFixed(8)),
    s2: Number(s2.toFixed(8)),
    s3: Number(s3.toFixed(8)),
  };
}

export function summarizeIndicators(candles) {
  const normalized = normalizeCandles(candles);
  const closes = normalized.map((c) => c.close);
  const latestClose = last(closes);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const sma20 = sma(closes, 20);
  const rsi14 = rsi(closes, 14);
  const macdValues = macd(closes, 12, 26, 9);
  const atr14 = atr(normalized, 14);
  const bb = bollingerBands(closes, 20, 2);
  const obvData = obv(normalized, 10);
  const stochRsiData = stochRsi(closes, 14, 14);
  const vwpmValue = vwpm(normalized, 10);
  // Pivot points from the most recent candle (acts as the "previous session" pivot)
  const pivots = pivotPoints(normalized.length > 0 ? normalized[normalized.length - 1] : null);

  let trendBias = "mixed";
  let bullish = 0;
  let bearish = 0;

  // EMA alignment
  if (ema9 !== null && ema21 !== null) {
    bullish += Number(ema9 > ema21);
    bearish += Number(ema9 < ema21);
  }
  if (ema21 !== null && ema50 !== null) {
    bullish += Number(ema21 > ema50);
    bearish += Number(ema21 < ema50);
  }
  // RSI
  if (rsi14 !== null) {
    bullish += Number(rsi14 >= 55);
    bearish += Number(rsi14 <= 45);
  }
  // MACD histogram
  if (macdValues.histogram !== null) {
    bullish += Number(macdValues.histogram > 0);
    bearish += Number(macdValues.histogram < 0);
  }
  // Price vs EMA21
  if (latestClose !== null && ema21 !== null) {
    bullish += Number(latestClose > ema21);
    bearish += Number(latestClose < ema21);
  }
  // OBV slope confirmation
  if (obvData.slope !== null) {
    bullish += Number(obvData.slope > 0.02);
    bearish += Number(obvData.slope < -0.02);
  }
  // Bollinger %B (price position within bands)
  if (bb.percentB !== null) {
    bullish += Number(bb.percentB > 0.6);
    bearish += Number(bb.percentB < 0.4);
  }
  // Stochastic RSI confirmation
  if (stochRsiData.k !== null) {
    bullish += Number(stochRsiData.k > 50 && stochRsiData.k < 80);  // momentum not overextended
    bearish += Number(stochRsiData.k < 50 && stochRsiData.k > 20);
  }
  // VWPM vs price
  if (vwpmValue !== null && latestClose !== null) {
    bullish += Number(latestClose > vwpmValue);
    bearish += Number(latestClose < vwpmValue);
  }

  if (bullish >= 6) {
    trendBias = "bullish";
  } else if (bearish >= 6) {
    trendBias = "bearish";
  }

  return {
    latestClose,
    ema9,
    ema21,
    ema50,
    sma20,
    rsi14,
    macd: macdValues.line,
    macdSignal: macdValues.signal,
    macdHistogram: macdValues.histogram,
    atr14,
    bb: {
      upper: bb.upper,
      mid: bb.mid,
      lower: bb.lower,
      width: bb.width,
      percentB: bb.percentB,
    },
    obv: obvData.value,
    obvSlope: obvData.slope,
    stochRsi: stochRsiData,
    vwpm: vwpmValue,
    pivots,
    trendBias,
    support: normalized.length ? Math.min(...normalized.slice(-20).map((c) => c.low)) : null,
    resistance: normalized.length
      ? Math.max(...normalized.slice(-20).map((c) => c.high))
      : null,
  };
}
