import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";

const DATA_DIR = path.resolve(process.cwd(), ".data");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  ensureDataDir();
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeSide(side) {
  const value = String(side ?? "").trim().toUpperCase();
  if (value !== "LONG" && value !== "SHORT") {
    throw new Error("Trade side must be LONG or SHORT");
  }
  return value;
}

function normalizeNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("Entry is required");
  }
  const type = String(entry.type ?? "price").toLowerCase();
  if (type === "market") {
    return { type: "market", price: entry.price ? normalizeNumber(entry.price, "Entry price") : null };
  }
  if (type === "zone" || entry.from !== undefined || entry.to !== undefined) {
    const from = normalizeNumber(entry.from, "Entry from");
    const to = normalizeNumber(entry.to, "Entry to");
    return { type: "zone", from: Math.min(from, to), to: Math.max(from, to) };
  }
  return { type: "price", price: normalizeNumber(entry.price, "Entry price") };
}

function normalizeTarget(target, index) {
  if (!target || typeof target !== "object") {
    throw new Error(`Target ${index + 1} is invalid`);
  }
  const exitPercent = normalizeNumber(target.exitPercent, `Target ${index + 1} exit percent`);
  if (exitPercent > 100) {
    throw new Error(`Target ${index + 1} exit percent cannot exceed 100`);
  }

  if (target.type === "range" || target.from !== undefined || target.to !== undefined) {
    const from = normalizeNumber(target.from, `Target ${index + 1} from`);
    const to = normalizeNumber(target.to, `Target ${index + 1} to`);
    return {
      type: "range",
      from: Math.min(from, to),
      to: Math.max(from, to),
      exitPercent,
      notifiedAt: target.notifiedAt ?? null,
    };
  }

  return {
    type: "price",
    price: normalizeNumber(target.price, `Target ${index + 1} price`),
    exitPercent,
    notifiedAt: target.notifiedAt ?? null,
  };
}

function referenceEntryPrice(entry) {
  if (entry.type === "zone") {
    return (entry.from + entry.to) / 2;
  }
  return entry.price;
}

function validateTradeShape(trade) {
  const symbol = String(trade.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{3,20}USDT$/.test(symbol)) {
    throw new Error("Trade symbol must be a USDT futures symbol, like BTCUSDT");
  }

  const side = normalizeSide(trade.side);
  const entry = normalizeEntry(trade.entry);
  const stopLoss = normalizeNumber(trade.stopLoss, "Stop loss");
  const targets = (trade.targets ?? []).map(normalizeTarget);
  if (targets.length === 0) {
    throw new Error("At least one target is required");
  }

  const exitTotal = targets.reduce((sum, target) => sum + target.exitPercent, 0);
  if (exitTotal > 100) {
    throw new Error("Target exit percentages cannot total more than 100");
  }

  const entryPrice = referenceEntryPrice(entry);
  if (entryPrice && side === "LONG" && stopLoss >= entryPrice) {
    throw new Error("LONG stop loss should be below entry");
  }
  if (entryPrice && side === "SHORT" && stopLoss <= entryPrice) {
    throw new Error("SHORT stop loss should be above entry");
  }

  for (const [index, target] of targets.entries()) {
    const targetPrice = target.type === "range" ? (target.from + target.to) / 2 : target.price;
    if (entryPrice && side === "LONG" && targetPrice <= entryPrice) {
      throw new Error(`LONG target ${index + 1} should be above entry`);
    }
    if (entryPrice && side === "SHORT" && targetPrice >= entryPrice) {
      throw new Error(`SHORT target ${index + 1} should be below entry`);
    }
  }

  return {
    symbol,
    side,
    status: trade.status ?? "active",
    entry,
    stopLoss,
    targets,
    notes: String(trade.notes ?? "").trim(),
    invalidation: Array.isArray(trade.invalidation)
      ? trade.invalidation.map(String).filter(Boolean)
      : [],
    riskNotes: Array.isArray(trade.riskNotes)
      ? trade.riskNotes.map(String).filter(Boolean)
      : [],
    confidence: String(trade.confidence ?? "unknown").toLowerCase(),
    alerts: trade.alerts ?? {},
  };
}

export class TradeStore {
  loadTrades() {
    return readJsonFile(TRADES_FILE, []);
  }

  saveTrades(trades) {
    writeJsonFile(TRADES_FILE, trades);
  }

  validateDraft(trade) {
    return validateTradeShape(trade);
  }

  addTrade(trade) {
    const now = new Date().toISOString();
    const normalized = validateTradeShape(trade);
    const saved = {
      id: `trade_${crypto.randomUUID().slice(0, 8)}`,
      ...normalized,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const trades = this.loadTrades();
    trades.push(saved);
    this.saveTrades(trades);
    return saved;
  }

  updateTrade(id, updater) {
    const trades = this.loadTrades();
    const index = trades.findIndex((trade) => trade.id === id);
    if (index === -1) {
      throw new Error(`Trade not found: ${id}`);
    }
    trades[index] = {
      ...updater(trades[index]),
      updatedAt: new Date().toISOString(),
    };
    this.saveTrades(trades);
    return trades[index];
  }

  removeTrade(id) {
    const trades = this.loadTrades();
    const next = trades.filter((trade) => trade.id !== id);
    if (next.length === trades.length) {
      throw new Error(`Trade not found: ${id}`);
    }
    this.saveTrades(next);
  }
}
