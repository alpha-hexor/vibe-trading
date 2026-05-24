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

  let trendBias = "mixed";
  let bullish = 0;
  let bearish = 0;
  if (ema9 !== null && ema21 !== null) {
    bullish += Number(ema9 > ema21);
    bearish += Number(ema9 < ema21);
  }
  if (ema21 !== null && ema50 !== null) {
    bullish += Number(ema21 > ema50);
    bearish += Number(ema21 < ema50);
  }
  if (rsi14 !== null) {
    bullish += Number(rsi14 >= 55);
    bearish += Number(rsi14 <= 45);
  }
  if (macdValues.histogram !== null) {
    bullish += Number(macdValues.histogram > 0);
    bearish += Number(macdValues.histogram < 0);
  }
  if (latestClose !== null && ema21 !== null) {
    bullish += Number(latestClose > ema21);
    bearish += Number(latestClose < ema21);
  }

  if (bullish >= 4) {
    trendBias = "bullish";
  } else if (bearish >= 4) {
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
    trendBias,
    support: normalized.length ? Math.min(...normalized.slice(-20).map((c) => c.low)) : null,
    resistance: normalized.length
      ? Math.max(...normalized.slice(-20).map((c) => c.high))
      : null,
  };
}
