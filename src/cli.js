import readline from "node:readline/promises";
import process from "node:process";
import { getConfig } from "./config.js";
import { OpenRouterAssistant } from "./assistant.js";
import { CoinSwitchFuturesClient } from "./marketClient.js";
import { SessionMemory } from "./memory.js";
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
    "/plan <amount>        Ask the assistant for a daily INR target trading plan",
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

function extractSymbolFromText(text) {
  const explicit = text.match(/\b([A-Za-z]{2,12}USDT)\b/);
  if (explicit) {
    return explicit[1].toUpperCase();
  }

  const symbolCue = /\b(symbol|pair|token|coin|asset|btc|eth|sol|xrp|bnb|doge|ada|link|sui|apt)\b/i;
  if (!symbolCue.test(text)) {
    return null;
  }

  const match = text.toUpperCase().match(/\b([A-Z]{3,12})\b/);
  if (!match) {
    return null;
  }
  const value = match[1];
  if (
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
    ].includes(value)
  ) {
    return null;
  }
  return `${value}USDT`;
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
