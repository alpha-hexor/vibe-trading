import readline from "node:readline/promises";
import process from "node:process";
import asciichart from "asciichart";
import { getConfig } from "./config.js";
import { HealthLogger, HEALTH_LOG_FILE } from "./healthLogger.js";
import { MonitorConfigStore } from "./monitorConfig.js";
import { OpenRouterAssistant } from "./assistant.js";
import { CoinSwitchFuturesClient } from "./marketClient.js";
import { SessionMemory } from "./memory.js";
import { NotificationConfigStore } from "./notificationConfig.js";
import { Notifier } from "./notifier.js";
import { TradeMonitor, parseMonitorInterval } from "./tradeMonitor.js";
import { TradeStore } from "./tradeStore.js";
import {
  appendAssistantStream,
  beginAssistantStream,
  endAssistantStream,
  formatNumber,
  formatPct,
  printBanner,
  printError,
  printPanel,
  printSuccess,
  promptLabel,
  startSpinner,
} from "./ui.js";

const LOCAL_GREETINGS = new Set(["hi", "hello", "hey", "yo", "hola"]);

const TERMINAL = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
};

const THINKING_PHRASES = [
  "reading the room",
  "checking the setup quality",
  "sorting signal from noise",
  "measuring risk",
  "building the trade map",
  "tightening the answer",
];

async function withSpinner(label, detail, action) {
  const spinner = startSpinner(label, { detail });
  try {
    return await action();
  } finally {
    spinner.stop();
  }
}

async function streamAssistantAnswer(assistant, request) {
  const spinner = startSpinner("thinking", { phrases: THINKING_PHRASES });
  let streamStarted = false;

  function startStream() {
    if (streamStarted) {
      return;
    }
    spinner.stop();
    beginAssistantStream();
    streamStarted = true;
  }

  try {
    const answer = await assistant.askStream({
      ...request,
      onToken: (token) => {
        startStream();
        appendAssistantStream(token);
      },
    });
    startStream();
    endAssistantStream();
    return answer;
  } catch (error) {
    spinner.stop();
    throw error;
  }
}

function printHelp() {
  printPanel("commands", [
    "/help                 Show available commands",
    "/market [limit]       Show top liquid futures contracts",
    "/scan [limit]         Scan for long/short setups using indicators",
    "/symbol <symbol>      Show full technical report for a symbol",
    "/graph <symbol>       Show a 24h terminal price graph",
    "/plan <amount>        Ask the assistant for a daily INR target trading plan",
    "/trade draft <plan>   Draft a monitored trade from a finalized plan",
    "/trade confirm        Save the latest drafted trade",
    "/trade list           Show monitored trades",
    "/trade details <id>   Show live chart with entry, stop, and targets",
    "/trade pause <id>     Pause a monitored trade",
    "/trade resume <id>    Resume a monitored trade",
    "/trade remove <id>    Remove a monitored trade",
    "/monitor start [15s]  Start trade monitoring",
    "/monitor health on    Enable 5m AI setup-validity checks",
    "/monitor stop         Stop trade monitoring",
    "/notification status  Show notification setup",
    "/ask <question>       Ask OpenRouter with live market context",
    "/memory               Show remembered session context",
    "/clear                Clear chat memory",
    "/exit                 Quit",
  ]);
}

function printMarketOverview(overview) {
  printPanel("market", [
    `USDT/INR ${formatNumber(overview.usdtInrRate, 2)}   symbols ${overview.symbolCount}`,
  ]);
  for (const row of overview.rows) {
    console.log(
      `${row.symbol.padEnd(12)}  $${formatNumber(row.markPriceUsd, 4).padStart(10)}  ₹${formatNumber(row.markPriceInr, 2).padStart(10)}  funding ${formatPct(row.fundingRatePct, 4).padStart(9)}  lev ${String(row.maxLeverage).padStart(4)}x`,
    );
  }
}

function printScan(scan) {
  for (const row of scan) {
    console.log(
      `${row.symbol.padEnd(12)} ${row.suggestedDirection.padEnd(5)} score ${String(row.opportunityScore).padStart(5)}  trend ${row.indicators.trendBias.padEnd(7)}  RSI ${formatNumber(row.indicators.rsi14, 1).padStart(5)}  MACD hist ${formatNumber(row.indicators.macdHistogram, 5)}`,
    );
  }
}

function printSymbolReport(report) {
  printPanel(report.symbol, [
    `${report.suggestedDirection}   score ${report.opportunityScore}   trend ${report.indicators.trendBias}`,
    `price $${formatNumber(report.markPriceUsd, 4)} / ₹${formatNumber(report.markPriceInr, 2)}   24h ${formatPct(report.priceChange24hPct, 2)}   funding ${formatPct(report.fundingRatePct, 4)}`,
    `EMA9 ${formatNumber(report.indicators.ema9, 4)}   EMA21 ${formatNumber(report.indicators.ema21, 4)}   EMA50 ${formatNumber(report.indicators.ema50, 4)}   RSI14 ${formatNumber(report.indicators.rsi14, 2)}`,
    `MACD ${formatNumber(report.indicators.macd, 5)}   signal ${formatNumber(report.indicators.macdSignal, 5)}   hist ${formatNumber(report.indicators.macdHistogram, 5)}   ATR14 ${formatNumber(report.indicators.atr14, 5)}`,
    `support ${formatNumber(report.indicators.support, 4)}   resistance ${formatNumber(report.indicators.resistance, 4)}   max lev ${report.maxLeverage}x`,
  ]);
}

function formatEntry(entry) {
  if (entry.type === "zone") {
    return `$${formatNumber(entry.from, priceDigits(entry.from))} - $${formatNumber(entry.to, priceDigits(entry.to))}`;
  }
  if (entry.type === "market") {
    return entry.price ? `market near $${formatNumber(entry.price, priceDigits(entry.price))}` : "market";
  }
  return `$${formatNumber(entry.price, priceDigits(entry.price))}`;
}

function formatTarget(target, index) {
  const price =
    target.type === "range"
      ? `$${formatNumber(target.from, priceDigits(target.from))} - $${formatNumber(target.to, priceDigits(target.to))}`
      : `$${formatNumber(target.price, priceDigits(target.price))}`;
  const done = target.notifiedAt ? " hit" : "";
  return `${index + 1}. ${price}   exit ${target.exitPercent}%${done}`;
}

function targetPrices(target) {
  if (target.type === "range") {
    return [target.from, target.to];
  }
  return [target.price];
}

function targetDisplayPrice(target) {
  if (target.type === "range") {
    return `${formatNumber(target.from, priceDigits(target.from))}-${formatNumber(target.to, priceDigits(target.to))}`;
  }
  return formatNumber(target.price, priceDigits(target.price));
}

function referenceEntryPrice(entry) {
  if (entry.type === "zone") {
    return (entry.from + entry.to) / 2;
  }
  return entry.price;
}

function pctDistance(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) {
    return "n/a";
  }
  const value = ((to - from) / from) * 100;
  return signedPct(value);
}

function printTrade(trade, title = trade.id ?? "draft") {
  printPanel(title, [
    `${trade.symbol} ${trade.side}   status ${trade.status ?? "draft"}   confidence ${trade.confidence ?? "unknown"}`,
    `entry ${formatEntry(trade.entry)}   stop $${formatNumber(trade.stopLoss, priceDigits(trade.stopLoss))}`,
    ...trade.targets.map(formatTarget),
    ...(trade.notes ? [`notes ${trade.notes}`] : []),
    ...(trade.riskNotes?.length ? [`risk ${trade.riskNotes.join("; ")}`] : []),
  ]);
}

function printTrades(trades) {
  if (trades.length === 0) {
    printPanel("trades", ["No monitored trades yet. Use /trade draft <plan>."]);
    return;
  }
  for (const trade of trades) {
    printTrade(trade);
  }
}

function tint(text, ...styles) {
  return `${styles.join("")}${text}${TERMINAL.reset}`;
}

function priceDigits(value) {
  if (!Number.isFinite(value)) {
    return 2;
  }
  if (Math.abs(value) >= 100) {
    return 2;
  }
  if (Math.abs(value) >= 1) {
    return 4;
  }
  return 6;
}

function signedPct(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatPct(value, 2)}`;
}

function downsample(values, width) {
  if (values.length <= width) {
    return values;
  }

  return Array.from({ length: width }, (_, index) => {
    const start = Math.floor((index * values.length) / width);
    const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / width));
    const bucket = values.slice(start, end);
    return bucket.reduce((sum, value) => sum + value, 0) / bucket.length;
  });
}

function terminalChartWidth() {
  const columns = process.stdout.columns ?? 100;
  return Math.max(48, Math.min(96, columns - 22));
}

function buildRangeBar({ low, high, current, width = 42 }) {
  if (![low, high, current].every(Number.isFinite) || high <= low) {
    return "";
  }
  const position = Math.max(
    0,
    Math.min(width - 1, Math.round(((current - low) / (high - low)) * (width - 1))),
  );
  return Array.from({ length: width }, (_, index) => {
    if (index === position) {
      return "●";
    }
    return index < position ? "━" : "─";
  }).join("");
}

function buildSparkline(values, width = 22) {
  const blocks = "▁▂▃▄▅▆▇█";
  const series = downsample(
    values.filter((value) => Number.isFinite(value)),
    width,
  );
  if (series.length === 0) {
    return "";
  }
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  return series
    .map((value) => {
      const index = Math.max(
        0,
        Math.min(blocks.length - 1, Math.round(((value - min) / range) * (blocks.length - 1))),
      );
      return blocks[index];
    })
    .join("");
}

function writeAt(chars, start, text) {
  for (let index = 0; index < text.length && start + index < chars.length; index += 1) {
    if (start + index >= 0) {
      chars[start + index] = text[index];
    }
  }
}

function buildTimeAxis({ offset, width }) {
  const axis = `${" ".repeat(offset - 1)}└${"─".repeat(Math.max(0, width - 1))}`;
  const labels = Array.from({ length: offset + width }, () => " ");
  const left = "24h ago";
  const middle = "12h ago";
  const right = "now";

  writeAt(labels, offset, left);
  writeAt(labels, offset + Math.floor(width / 2) - Math.floor(middle.length / 2), middle);
  writeAt(labels, offset + width - right.length, right);

  return [axis, labels.join("").trimEnd()];
}

function currentPriceRowIndex({ current, min, max, height }) {
  if (![current, min, max].every(Number.isFinite)) {
    return null;
  }
  const range = Math.abs(max - min);
  const ratio = range !== 0 ? height / range : 1;
  const min2 = Math.round(min * ratio);
  const max2 = Math.round(max * ratio);
  const rows = Math.abs(max2 - min2);
  const y = Math.round(current * ratio) - min2;
  return Math.max(0, Math.min(rows, rows - y));
}

function annotateCurrentPrice(chart, { current, min, max, height }) {
  const rowIndex = currentPriceRowIndex({ current, min, max, height });
  if (rowIndex === null) {
    return chart;
  }
  const lines = chart.split("\n");
  if (!lines[rowIndex]) {
    return chart;
  }
  const digits = priceDigits(current);
  lines[rowIndex] = `${lines[rowIndex]} ${tint("●", TERMINAL.magenta)} ${tint(`$${formatNumber(current, digits)}`, TERMINAL.magenta)}`;
  return lines.join("\n");
}

function buildPriceGraph(values, report, { width = terminalChartWidth(), height = 14 } = {}) {
  const series = downsample(
    values.filter((value) => Number.isFinite(value)),
    width,
  );
  if (series.length === 0) {
    return null;
  }

  const bounds = [report.low24hUsd, report.high24hUsd].filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  const min = Math.min(...series, ...bounds);
  const max = Math.max(...series, ...bounds);
  const digits = priceDigits(max);
  const labelWidth = Math.max(10, formatNumber(max, digits).length + 2);
  const lineColor = report.priceChange24hPct >= 0 ? asciichart.green : asciichart.red;
  const offset = labelWidth + 2;
  const chart = asciichart.plot(series, {
    height,
    min,
    max,
    offset,
    padding: " ".repeat(labelWidth),
    colors: [lineColor],
    format: (value) => formatNumber(value, digits).padStart(labelWidth),
  });

  return {
    chart: annotateCurrentPrice(chart, {
      current: report.markPriceUsd,
      min,
      max,
      height,
    }),
    timeAxis: buildTimeAxis({ offset, width: series.length }),
  };
}

function horizontalSeries(value, width) {
  return Array.from({ length: width }, () => value);
}

function tradeOverlayLevels(trade) {
  const levels = [];
  const entryPrice = referenceEntryPrice(trade.entry);
  if (Number.isFinite(entryPrice)) {
    levels.push({
      label: "entry",
      value: entryPrice,
      color: asciichart.yellow,
      terminalColor: TERMINAL.yellow,
    });
  }
  if (trade.entry.type === "zone") {
    levels.push({
      label: "entry low",
      value: trade.entry.from,
      color: asciichart.yellow,
      terminalColor: TERMINAL.yellow,
    });
    levels.push({
      label: "entry high",
      value: trade.entry.to,
      color: asciichart.yellow,
      terminalColor: TERMINAL.yellow,
    });
  }
  levels.push({
    label: "stop",
    value: trade.stopLoss,
    color: asciichart.red,
    terminalColor: TERMINAL.red,
  });

  for (const [index, target] of trade.targets.entries()) {
    const values = targetPrices(target);
    for (const [priceIndex, value] of values.entries()) {
      levels.push({
        label:
          target.type === "range"
            ? `target ${index + 1} ${priceIndex === 0 ? "low" : "high"}`
            : `target ${index + 1}`,
        value,
        color: asciichart.green,
        terminalColor: TERMINAL.green,
      });
    }
  }
  return levels.filter((level) => Number.isFinite(level.value));
}

function buildTradeDetailsGraph(values, report, trade, { width = terminalChartWidth(), height = 16 } = {}) {
  const priceSeries = downsample(
    values.filter((value) => Number.isFinite(value)),
    width,
  );
  if (priceSeries.length === 0) {
    return null;
  }

  const levels = tradeOverlayLevels(trade);
  const bounds = [
    report.low24hUsd,
    report.high24hUsd,
    ...levels.map((level) => level.value),
  ].filter((value) => Number.isFinite(value) && value > 0);
  const min = Math.min(...priceSeries, ...bounds);
  const max = Math.max(...priceSeries, ...bounds);
  const digits = priceDigits(max);
  const labelWidth = Math.max(10, formatNumber(max, digits).length + 2);
  const offset = labelWidth + 2;
  const lineColor = report.priceChange24hPct >= 0 ? asciichart.green : asciichart.red;
  const series = [
    priceSeries,
    ...levels.map((level) => horizontalSeries(level.value, priceSeries.length)),
  ];
  const colors = [lineColor, ...levels.map((level) => level.color)];
  const chart = asciichart.plot(series, {
    height,
    min,
    max,
    offset,
    padding: " ".repeat(labelWidth),
    colors,
    format: (value) => formatNumber(value, digits).padStart(labelWidth),
  });

  return {
    chart: annotateCurrentPrice(chart, {
      current: report.markPriceUsd,
      min,
      max,
      height,
    }),
    levels,
    timeAxis: buildTimeAxis({ offset, width: priceSeries.length }),
  };
}

function printPriceGraph(report) {
  const candles = report.candles15m ?? [];
  const closes = candles.map((candle) => candle.close);
  const digits = priceDigits(report.markPriceUsd);
  const isUp = report.priceChange24hPct >= 0;
  const directionColor = isUp ? TERMINAL.green : TERMINAL.red;
  const changeIcon = isUp ? "▲" : "▼";
  const graph = buildPriceGraph(closes, report);
  const rangeBar = buildRangeBar({
    low: report.low24hUsd,
    high: report.high24hUsd,
    current: report.markPriceUsd,
  });
  const sparkline = buildSparkline(closes);

  if (!graph) {
    printError(`No candle data available for ${report.symbol}`);
    return;
  }

  console.log("");
  console.log(
    `${tint(report.symbol, TERMINAL.bold, TERMINAL.white)} ${tint("24h futures chart", TERMINAL.gray)}  ${tint(sparkline, directionColor)}`,
  );
  console.log(
    `${tint("current", TERMINAL.magenta)} ${tint("●", TERMINAL.magenta)} ${tint(`$${formatNumber(report.markPriceUsd, digits)}`, TERMINAL.bold, TERMINAL.white)}  ` +
      `${tint("inr", TERMINAL.gray)} ₹${formatNumber(report.markPriceInr, 2)}  ` +
      `${tint("24h", TERMINAL.gray)} ${tint(`${changeIcon} ${signedPct(report.priceChange24hPct)}`, directionColor)}`,
  );
  console.log(
    `${tint("low", TERMINAL.gray)} $${formatNumber(report.low24hUsd, digits)}  ` +
      `${tint(rangeBar, directionColor)}  ` +
      `${tint("high", TERMINAL.gray)} $${formatNumber(report.high24hUsd, digits)}`,
  );
  console.log(
    `${tint("candles", TERMINAL.gray)} ${candles.length} x 15m  ` +
      `${tint("range", TERMINAL.gray)} $${formatNumber(report.high24hUsd - report.low24hUsd, digits)}`,
  );
  console.log(tint("─".repeat(Math.min(100, process.stdout.columns ?? 100)), TERMINAL.gray));
  console.log(graph.chart);
  for (const line of graph.timeAxis) {
    console.log(tint(line, TERMINAL.gray));
  }
  console.log(tint("─".repeat(Math.min(100, process.stdout.columns ?? 100)), TERMINAL.gray));
}

function printTradeDetails(report, trade) {
  const candles = report.candles15m ?? [];
  const closes = candles.map((candle) => candle.close);
  const digits = priceDigits(report.markPriceUsd);
  const isUp = report.priceChange24hPct >= 0;
  const directionColor = isUp ? TERMINAL.green : TERMINAL.red;
  const changeIcon = isUp ? "▲" : "▼";
  const graph = buildTradeDetailsGraph(closes, report, trade);

  if (!graph) {
    printError(`No candle data available for ${report.symbol}`);
    return;
  }

  const entryPrice = referenceEntryPrice(trade.entry);
  const stopDistance = pctDistance(report.markPriceUsd, trade.stopLoss);
  const targetLines = trade.targets.map((target, index) => {
    const firstTarget = targetPrices(target)[0];
    return `target ${index + 1} $${targetDisplayPrice(target)}   exit ${target.exitPercent}%   from current ${pctDistance(report.markPriceUsd, firstTarget)}${target.notifiedAt ? "   hit" : ""}`;
  });

  console.log("");
  console.log(
    `${tint(trade.id, TERMINAL.gray)} ${tint(trade.symbol, TERMINAL.bold, TERMINAL.white)} ${tint(trade.side, TERMINAL.bold, trade.side === "LONG" ? TERMINAL.green : TERMINAL.red)} ${tint("trade details", TERMINAL.gray)}`,
  );
  console.log(
    `${tint("current", TERMINAL.magenta)} ${tint("●", TERMINAL.magenta)} ${tint(`$${formatNumber(report.markPriceUsd, digits)}`, TERMINAL.bold, TERMINAL.white)}  ` +
      `${tint("24h", TERMINAL.gray)} ${tint(`${changeIcon} ${signedPct(report.priceChange24hPct)}`, directionColor)}  ` +
      `${tint("status", TERMINAL.gray)} ${trade.status}`,
  );
  console.log(
    `${tint("entry", TERMINAL.yellow)} ${formatEntry(trade.entry)}  ` +
      `${tint("from current", TERMINAL.gray)} ${pctDistance(report.markPriceUsd, entryPrice)}  ` +
      `${tint("stop", TERMINAL.red)} $${formatNumber(trade.stopLoss, priceDigits(trade.stopLoss))} (${stopDistance})`,
  );
  for (const line of targetLines) {
    console.log(`${tint("exit", TERMINAL.green)} ${line}`);
  }
  if (trade.notes) {
    console.log(`${tint("notes", TERMINAL.gray)} ${trade.notes}`);
  }
  if (trade.riskNotes?.length) {
    console.log(`${tint("risk", TERMINAL.gray)} ${trade.riskNotes.join("; ")}`);
  }

  const legend = [
    tint("price", directionColor),
    tint("current ●", TERMINAL.magenta),
    tint("entry", TERMINAL.yellow),
    tint("stop", TERMINAL.red),
    tint("targets", TERMINAL.green),
  ].join(tint("  •  ", TERMINAL.gray));
  console.log(`${tint("legend", TERMINAL.gray)} ${legend}`);
  console.log(tint("─".repeat(Math.min(100, process.stdout.columns ?? 100)), TERMINAL.gray));
  console.log(graph.chart);
  for (const line of graph.timeAxis) {
    console.log(tint(line, TERMINAL.gray));
  }
  console.log(tint("─".repeat(Math.min(100, process.stdout.columns ?? 100)), TERMINAL.gray));
}

function extractSymbolFromText(text) {
  const explicit = text.match(/\b([A-Za-z]{2,12}USDT)\b/);
  if (explicit) {
    return explicit[1].toUpperCase();
  }

  const symbolCue = /\b(symbol|pair|token|coin|asset|btc|eth|sol|xrp|bnb|doge|ada|link|sui|apt)\b/i;
  if (!symbolCue.test(text)) {
    return null;
  }

  const ignored = new Set(
    [
      "LONG",
      "SHORT",
      "RSI",
      "MACD",
      "EMA",
      "ATR",
      "HELP",
      "EXIT",
      "PLAN",
      "SCAN",
      "MARKET",
      "FUTURES",
      "TRADE",
      "TODAY",
    ],
  );
  const matches = text.toUpperCase().matchAll(/\b([A-Z]{3,12})\b/g);
  for (const match of matches) {
    const value = match[1];
    if (!ignored.has(value)) {
      return `${value}USDT`;
    }
  }
  return null;
}

async function buildAskContext({ input, client }) {
  const symbol = extractSymbolFromText(input);
  const lower = input.toLowerCase();

  const needsPlan =
    /\b(plan|target|income|profit|invest|investment|account|capital|margin|deploy|allocate|buy|sell|long|short|trade|setup)\b/.test(
      lower,
    ) || /\b₹|rs\b/i.test(input);
  const capitalMatch = input.match(
    /(?:i have|my account(?: size| balance)? is|account(?: size| balance)?|capital(?: available)?|margin(?: available)?|budget|balance|with)\s*(?:of\s*)?(?:₹|rs\.?\s*|inr\s*)?(\d[\d,]*(?:\.\d+)?)/i,
  );
  const targetMatch = input.match(
    /(?:target|income|profit|make|goal)\s*(?:of\s*)?(?:₹|rs\.?\s*|inr\s*)?(\d[\d,]*(?:\.\d+)?)/i,
  );
  const amount = capitalMatch
    ? Number(capitalMatch[1].replaceAll(",", ""))
    : targetMatch
      ? Number(targetMatch[1].replaceAll(",", ""))
      : null;
  const needsMarketOverview =
    /\bmarket|overview|snapshot|today|now|currently\b/.test(lower) || needsPlan;
  const needsScan =
    /\bscan|setup|opportunit|long|short|invest|investment|account|capital|margin|deploy|allocate|buy|sell|trade|today|best\b/.test(
      lower,
    ) || needsPlan;

  const [marketOverview, scans, symbolReport] = await Promise.all([
    needsMarketOverview ? client.getMarketOverview({ limit: 8 }) : null,
    needsScan ? client.scanMarket({ limit: 6 }) : null,
    symbol
      ? client.buildSymbolReport(symbol).catch(() => null)
      : null,
  ]);

  const planContext =
    needsPlan && amount
      ? {
          dailyTargetInr: amount,
          accountCapitalInr: amount,
          smallAccountGuide: buildSmallAccountGuide(amount),
          scannedSetups: scans ?? (await client.scanMarket({ limit: 8 })),
        }
      : null;

  return { marketOverview, scans, symbolReport, planContext };
}

function buildSmallAccountGuide(amount) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  if (amount <= 500) {
    return {
      tier: "micro",
      guidance:
        "Very small account. Favor observation or a single tiny high-conviction setup only. Avoid high leverage and avoid forcing a daily income target.",
      maxConcurrentTrades: 1,
      suggestedLeverageRange: "1x-3x",
      riskNote: "A normal stop can consume a meaningful share of this account.",
    };
  }
  if (amount <= 1000) {
    return {
      tier: "small",
      guidance:
        "Small account. Focus on one setup at a time, tight capital discipline, and moderate leverage only when liquidity is decent.",
      maxConcurrentTrades: 1,
      suggestedLeverageRange: "2x-4x",
      riskNote: "Trying to hit large daily INR profits from this base usually forces poor risk decisions.",
    };
  }
  if (amount <= 5000) {
    return {
      tier: "starter",
      guidance:
        "Starter account. One or two setups are possible, but only if the scanner shows clean momentum and acceptable funding conditions.",
      maxConcurrentTrades: 2,
      suggestedLeverageRange: "2x-5x",
      riskNote: "Still too small to diversify heavily across multiple futures positions.",
    };
  }
  return {
    tier: "standard",
    guidance:
      "Moderate account size. Diversification across a few setups becomes possible, but trade quality still matters more than position count.",
    maxConcurrentTrades: 3,
    suggestedLeverageRange: "2x-6x",
    riskNote: "Do not increase leverage just because the account is larger.",
  };
}

function localResponse(input, memory) {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  if (LOCAL_GREETINGS.has(lower)) {
    const capital = memory.buildSummary().preferences?.capital_inr;
    if (capital) {
      return `Hi. I’m ready. I remember you mentioned roughly ₹${capital} of capital. Ask for a market view, symbol analysis, or what to do with that account size today.`;
    }
    return "Hi. I’m ready. Ask what the best setups look like today, analyze a symbol, or tell me your INR account size and I’ll frame the plan around it.";
  }
  if (lower === "help") {
    return "Use normal chat for questions like 'I have 500 rs inr, what should I invest in today?' or use /help for direct commands.";
  }
  return null;
}

async function main() {
  const config = getConfig();
  const assistant = new OpenRouterAssistant(config);
  const client = new CoinSwitchFuturesClient({ exchange: config.exchange });
  const memory = new SessionMemory();
  const tradeStore = new TradeStore();
  const notificationStore = new NotificationConfigStore();
  const monitorConfigStore = new MonitorConfigStore();
  const notifier = new Notifier(notificationStore);
  const monitor = new TradeMonitor({
    assistant,
    client,
    store: tradeStore,
    notifier,
    monitorConfigStore,
    healthLogger: new HealthLogger({ enabled: config.debug }),
  });
  let latestTradeDraft = null;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  printBanner(config);

  while (true) {
    let input;
    try {
      input = (await rl.question(`${promptLabel()} `)).trim();
    } catch {
      break;
    }

    if (!input) {
      continue;
    }

    try {
      if (input === "/exit" || input === "/quit") {
        monitor.stop();
        break;
      }

      if (input === "/help") {
        printHelp();
        continue;
      }

      if (input === "/clear") {
        assistant.clearHistory();
        memory.clear();
        printSuccess("memory cleared");
        continue;
      }

      if (input === "/memory") {
        const snapshot = memory.buildSummary();
        printPanel("memory", [
          `preferences ${JSON.stringify(snapshot.preferences)}`,
          `recent_turns ${snapshot.recentTurns.length}`,
          ...snapshot.recentTurns.map(
            (turn, index) => `${index + 1}. ${turn.role}: ${turn.text}`,
          ),
        ]);
        continue;
      }

      if (input.startsWith("/market")) {
        const [, rawLimit] = input.split(/\s+/, 2);
        const limit = Math.max(1, Number(rawLimit || 10));
        const overview = await withSpinner("fetching market overview", "", () =>
          client.getMarketOverview({ limit }),
        );
        printMarketOverview(overview);
        continue;
      }

      if (input.startsWith("/scan")) {
        const [, rawLimit] = input.split(/\s+/, 2);
        const limit = Math.max(1, Number(rawLimit || 8));
        const scan = await withSpinner("scanning live setups", "", () =>
          client.scanMarket({ limit }),
        );
        printScan(scan);
        continue;
      }

      if (input.startsWith("/symbol")) {
        const [, rawSymbol] = input.split(/\s+/, 2);
        if (!rawSymbol) {
          printError("Usage: /symbol <symbol>");
          continue;
        }
        const report = await withSpinner(
          "building symbol report",
          rawSymbol.toUpperCase(),
          () => client.buildSymbolReport(rawSymbol),
        );
        printSymbolReport(report);
        continue;
      }

      if (input.startsWith("/graph")) {
        const [, rawSymbol] = input.split(/\s+/, 2);
        if (!rawSymbol) {
          printError("Usage: /graph <symbol>");
          continue;
        }
        const report = await withSpinner(
          "building price graph",
          rawSymbol.toUpperCase(),
          () => client.buildSymbolReport(rawSymbol),
        );
        printPriceGraph(report);
        continue;
      }

      if (input.startsWith("/notification")) {
        const parts = input.split(/\s+/);
        const action = parts[1] ?? "status";

        if (action === "status") {
          const status = notificationStore.status();
          printPanel("notifications", [
            `discord ${status.discord}`,
            `telegram ${status.telegram}`,
          ]);
          continue;
        }

        if (action === "discord") {
          const webhookUrl = input.slice("/notification discord".length).trim();
          notificationStore.setDiscord(webhookUrl);
          printSuccess("discord notifications configured");
          continue;
        }

        if (action === "telegram") {
          const [, , botToken, chatId] = parts;
          notificationStore.setTelegram(botToken, chatId);
          printSuccess("telegram notifications configured");
          continue;
        }

        if (action === "test") {
          await withSpinner("sending notification test", "", () => notifier.sendTest());
          printSuccess("notification test sent");
          continue;
        }

        if (action === "clear") {
          notificationStore.clear();
          printSuccess("notification settings cleared");
          continue;
        }

        printError("Usage: /notification status|test|clear|discord <webhook_url>|telegram <bot_token> <chat_id>");
        continue;
      }

      if (input.startsWith("/trade")) {
        const parts = input.split(/\s+/);
        const action = parts[1] ?? "list";

        if (action === "draft") {
          const tradeText = input.slice("/trade draft".length).trim();
          if (!tradeText) {
            printError("Usage: /trade draft <finalized trade plan>");
            continue;
          }

          const symbol = extractSymbolFromText(tradeText);
          const symbolReport = symbol
            ? await withSpinner("gathering trade context", symbol, () =>
                client.buildSymbolReport(symbol).catch(() => null),
              )
            : null;
          const draft = await withSpinner("drafting monitored trade", "", () =>
            assistant.draftTradeJson({
              tradeText,
              symbolReport,
              sessionMemory: memory.buildSummary(),
            }),
          );

          if (!draft.symbol && symbol) {
            draft.symbol = symbol;
          }
          draft.symbol = await withSpinner("resolving symbol", draft.symbol ?? "", () =>
            client.resolveSymbol(draft.symbol),
          );
          latestTradeDraft = tradeStore.validateDraft(draft);
          printTrade(latestTradeDraft, "draft");
          printPanel("next", ["Review the draft, then run /trade confirm to monitor it."]);
          continue;
        }

        if (action === "confirm") {
          if (!latestTradeDraft) {
            printError("No draft to confirm. Use /trade draft <plan> first.");
            continue;
          }
          const saved = tradeStore.addTrade(latestTradeDraft);
          latestTradeDraft = null;
          printSuccess("trade added", saved.id);
          printTrade(saved);
          continue;
        }

        if (action === "list") {
          printTrades(tradeStore.loadTrades());
          continue;
        }

        if (action === "show") {
          const id = parts[2];
          const trade = tradeStore.loadTrades().find((item) => item.id === id);
          if (!trade) {
            printError(`Trade not found: ${id}`);
            continue;
          }
          printTrade(trade);
          continue;
        }

        if (action === "details") {
          const id = parts[2];
          const trade = tradeStore.loadTrades().find((item) => item.id === id);
          if (!trade) {
            printError(`Trade not found: ${id}`);
            continue;
          }
          const report = await withSpinner("building trade details", trade.symbol, () =>
            client.buildSymbolReport(trade.symbol),
          );
          printTradeDetails(report, trade);
          continue;
        }

        if (["pause", "resume", "close"].includes(action)) {
          const id = parts[2];
          if (!id) {
            printError(`Usage: /trade ${action} <id>`);
            continue;
          }
          const status = action === "resume" ? "active" : action === "pause" ? "paused" : "closed";
          const trade = tradeStore.updateTrade(id, (item) => ({ ...item, status }));
          printSuccess(`trade ${status}`, trade.id);
          continue;
        }

        if (action === "remove") {
          const id = parts[2];
          if (!id) {
            printError("Usage: /trade remove <id>");
            continue;
          }
          tradeStore.removeTrade(id);
          printSuccess("trade removed", id);
          continue;
        }

        printError("Usage: /trade draft|confirm|list|show|details|pause|resume|close|remove");
        continue;
      }

      if (input.startsWith("/monitor")) {
        const parts = input.split(/\s+/);
        const action = parts[1] ?? "status";

        if (action === "status") {
          const status = monitor.status();
          printPanel("monitor", [
            `running ${status.running}`,
            `interval ${Math.round(status.intervalMs / 1000)}s`,
            `health ${status.healthEnabled ? "on" : "off"} every ${Math.round(status.healthIntervalMs / 60000)}m`,
            `last_check ${status.lastCheckAt ?? "never"}`,
            `last_health_check ${status.lastHealthCheckAt ?? "never"}`,
            `debug_log ${config.debug ? HEALTH_LOG_FILE : "off"}`,
            `last_error ${status.lastError ?? "none"}`,
          ]);
          continue;
        }

        if (action === "health") {
          const healthAction = parts[2] ?? "status";

          if (healthAction === "status") {
            const status = monitor.status();
            printPanel("monitor health", [
              `enabled ${status.healthEnabled}`,
              `interval ${Math.round(status.healthIntervalMs / 60000)}m`,
              `last_health_check ${status.lastHealthCheckAt ?? "never"}`,
              `debug_log ${config.debug ? HEALTH_LOG_FILE : "off"}`,
            ]);
            continue;
          }

          if (healthAction === "on") {
            monitorConfigStore.setHealthEnabled(true);
            printSuccess("monitor health enabled", "AI validity checks every 5m");
            continue;
          }

          if (healthAction === "off") {
            monitorConfigStore.setHealthEnabled(false);
            printSuccess("monitor health disabled");
            continue;
          }

          if (healthAction === "check") {
            if (!notifier.isConfigured()) {
              printError("Configure notifications first with /notification discord <webhook_url> or /notification telegram <bot_token> <chat_id>");
              continue;
            }
            const alerts = await withSpinner("running AI health check", "", () =>
              monitor.runHealthChecks(),
            );
            printSuccess("AI health check complete", `${alerts.length} alert(s)`);
            continue;
          }

          printError("Usage: /monitor health status|on|off|check");
          continue;
        }

        if (action === "start") {
          if (!notifier.isConfigured()) {
            printError("Configure notifications first with /notification discord <webhook_url> or /notification telegram <bot_token> <chat_id>");
            continue;
          }
          const intervalMs = parseMonitorInterval(parts[2]);
          await withSpinner("starting monitor", `${Math.round(intervalMs / 1000)}s`, () =>
            monitor.start(intervalMs),
          );
          await notifier.sendTradeAlert({ type: "monitor_started", symbol: "Claude Future" });
          printSuccess("monitor started", `${Math.round(intervalMs / 1000)}s`);
          continue;
        }

        if (action === "stop") {
          monitor.stop();
          printSuccess("monitor stopped");
          continue;
        }

        if (action === "check") {
          const alerts = await withSpinner("checking monitored trades", "", () =>
            monitor.checkOnce(),
          );
          printSuccess("monitor check complete", `${alerts.length} alert(s)`);
          continue;
        }

        printError("Usage: /monitor status|start [15s]|stop|check|health status|health on|health off|health check");
        continue;
      }

      if (input.startsWith("/plan")) {
        const [, rawAmount] = input.split(/\s+/, 2);
        const amount = Number((rawAmount || "").replaceAll(",", ""));
        if (!Number.isFinite(amount) || amount <= 0) {
          printError("Usage: /plan <daily_target_inr>");
          continue;
        }
        const scan = await withSpinner("scanning market", "building planning context", () =>
          client.scanMarket({ limit: 8 }),
        );
        const answer = await streamAssistantAnswer(assistant, {
          question: `Build a futures trading plan to pursue approximately INR ${amount.toFixed(0)} in daily profit from the scanned setups. Be explicit about which setups are strongest, what capital sizing would likely be needed, and where the risk becomes unreasonable.`,
          scans: scan,
          planContext: {
            dailyTargetInr: amount,
            accountCapitalInr: amount,
            smallAccountGuide: buildSmallAccountGuide(amount),
            scannedSetups: scan,
          },
          sessionMemory: memory.buildSummary(),
        });
        memory.addTurn("user", input);
        memory.addTurn("assistant", answer);
        continue;
      }

      if (input.startsWith("/ask ")) {
        const question = input.slice(5).trim();
        if (!question) {
          printError("Usage: /ask <question>");
          continue;
        }
        const context = await withSpinner("gathering market context", "", () =>
          buildAskContext({ input: question, client }),
        );
        const answer = await streamAssistantAnswer(assistant, {
          question,
          ...context,
          sessionMemory: memory.buildSummary(),
        });
        memory.addTurn("user", question);
        memory.addTurn("assistant", answer);
        continue;
      }

      const local = localResponse(input, memory);
      if (local) {
        memory.addTurn("user", input);
        memory.addTurn("assistant", local);
        beginAssistantStream();
        appendAssistantStream(local);
        endAssistantStream();
        continue;
      }

      const context = await withSpinner("gathering market context", "", () =>
        buildAskContext({ input, client }),
      );
      const answer = await streamAssistantAnswer(assistant, {
        question: input,
        ...context,
        sessionMemory: memory.buildSummary(),
      });
      memory.addTurn("user", input);
      memory.addTurn("assistant", answer);
    } catch (error) {
      printError(error instanceof Error ? error.message : String(error));
    }
  }

  rl.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
