function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (Math.abs(value) >= 100) {
    return value.toFixed(2);
  }
  if (Math.abs(value) >= 1) {
    return value.toFixed(4);
  }
  return value.toFixed(6);
}

export function parseMonitorInterval(rawValue) {
  const value = String(rawValue ?? "").trim().toLowerCase();
  if (!value) {
    return 15_000;
  }
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!match) {
    throw new Error("Monitor interval must look like 15s, 30s, or 1m");
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const ms = unit === "m" ? amount * 60_000 : unit === "s" ? amount * 1000 : amount;
  if (ms < 10_000) {
    throw new Error("Monitor interval cannot be less than 10s");
  }
  if (ms > 300_000) {
    throw new Error("Monitor interval cannot be more than 5m");
  }
  return Math.round(ms);
}

function targetTriggerPrice(target, side) {
  if (target.type === "range") {
    return side === "LONG" ? target.from : target.to;
  }
  return target.price;
}

function targetLabel(target) {
  if (target.type === "range") {
    return `${formatPrice(target.from)}-${formatPrice(target.to)}`;
  }
  return formatPrice(target.price);
}

function entryContains(entry, price) {
  if (entry.type === "market") {
    return false;
  }
  if (entry.type === "zone") {
    return price >= entry.from && price <= entry.to;
  }
  return Math.abs(price - entry.price) / entry.price <= 0.001;
}

function reachedPrice({ side, price, trigger }) {
  return side === "LONG" ? price >= trigger : price <= trigger;
}

function stoppedOut({ side, price, stopLoss }) {
  return side === "LONG" ? price <= stopLoss : price >= stopLoss;
}

function stopDistancePct({ side, price, stopLoss }) {
  const raw = side === "LONG" ? (price - stopLoss) / price : (stopLoss - price) / price;
  return raw * 100;
}

function buildAlertsForTrade(trade, price) {
  const alerts = [];
  const now = new Date().toISOString();
  const nextTrade = structuredClone(trade);
  nextTrade.alerts ??= {};

  if (entryContains(nextTrade.entry, price) && !nextTrade.alerts.entryZoneEnteredAt) {
    nextTrade.alerts.entryZoneEnteredAt = now;
    alerts.push({
      type: "entry_zone_entered",
      symbol: nextTrade.symbol,
      side: nextTrade.side,
      currentPrice: formatPrice(price),
      triggerPrice:
        nextTrade.entry.type === "zone"
          ? `${formatPrice(nextTrade.entry.from)}-${formatPrice(nextTrade.entry.to)}`
          : formatPrice(nextTrade.entry.price),
    });
  }

  const distance = stopDistancePct({
    side: nextTrade.side,
    price,
    stopLoss: nextTrade.stopLoss,
  });
  if (distance >= 0 && distance <= 0.5 && !nextTrade.alerts.nearStopLossAt) {
    nextTrade.alerts.nearStopLossAt = now;
    alerts.push({
      type: "near_stop_loss",
      symbol: nextTrade.symbol,
      side: nextTrade.side,
      currentPrice: formatPrice(price),
      triggerPrice: formatPrice(nextTrade.stopLoss),
      distancePct: `${distance.toFixed(2)}%`,
    });
  }

  if (stoppedOut({ side: nextTrade.side, price, stopLoss: nextTrade.stopLoss })) {
    if (!nextTrade.alerts.stopLossHitAt) {
      nextTrade.alerts.stopLossHitAt = now;
      nextTrade.status = "stopped";
      alerts.push({
        type: "stop_loss_hit",
        symbol: nextTrade.symbol,
        side: nextTrade.side,
        currentPrice: formatPrice(price),
        triggerPrice: formatPrice(nextTrade.stopLoss),
      });
    }
    return { trade: nextTrade, alerts };
  }

  nextTrade.targets = nextTrade.targets.map((target, index) => {
    if (target.notifiedAt) {
      return target;
    }
    const trigger = targetTriggerPrice(target, nextTrade.side);
    if (!reachedPrice({ side: nextTrade.side, price, trigger })) {
      return target;
    }

    alerts.push({
      type: "target_hit",
      symbol: nextTrade.symbol,
      side: nextTrade.side,
      currentPrice: formatPrice(price),
      triggerPrice: targetLabel(target),
      exitPercent: target.exitPercent,
      note: `Target ${index + 1}`,
    });
    return { ...target, notifiedAt: now };
  });

  if (nextTrade.targets.every((target) => target.notifiedAt)) {
    nextTrade.status = "completed";
  }

  return { trade: nextTrade, alerts };
}

export class TradeMonitor {
  constructor({
    assistant = null,
    client,
    store,
    notifier,
    monitorConfigStore = null,
    healthLogger = null,
  }) {
    this.assistant = assistant;
    this.client = client;
    this.store = store;
    this.notifier = notifier;
    this.monitorConfigStore = monitorConfigStore;
    this.healthLogger = healthLogger;
    this.timer = null;
    this.intervalMs = 15_000;
    this.lastCheckAt = null;
    this.lastHealthCheckAt = null;
    this.lastError = null;
  }

  isRunning() {
    return Boolean(this.timer);
  }

  status() {
    const monitorConfig = this.monitorConfigStore?.load() ?? {
      healthEnabled: false,
      healthIntervalMs: 5 * 60 * 1000,
    };
    return {
      running: this.isRunning(),
      intervalMs: this.intervalMs,
      healthEnabled: monitorConfig.healthEnabled,
      healthIntervalMs: monitorConfig.healthIntervalMs,
      lastCheckAt: this.lastCheckAt,
      lastHealthCheckAt: this.lastHealthCheckAt,
      lastError: this.lastError,
    };
  }

  async start(intervalMs = 15_000) {
    this.stop();
    this.intervalMs = intervalMs;
    await this.checkOnce();
    this.timer = setInterval(() => {
      this.checkOnce().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkOnce() {
    const trades = this.store.loadTrades();
    const activeTrades = trades.filter((trade) => trade.status === "active");
    if (activeTrades.length === 0) {
      this.lastCheckAt = new Date().toISOString();
      return [];
    }

    const snapshot = await this.client.getMarketSnapshot();
    const prices = new Map(
      snapshot
        .filter((row) => row.market)
        .map((row) => [row.symbol, Number(row.market.markPrice)]),
    );
    const nextTrades = [...trades];
    const alerts = [];

    for (const trade of activeTrades) {
      const price = prices.get(trade.symbol);
      if (!Number.isFinite(price)) {
        continue;
      }
      const result = buildAlertsForTrade(trade, price);
      if (result.alerts.length === 0 && result.trade.status === trade.status) {
        continue;
      }

      for (const alert of result.alerts) {
        await this.notifier.sendTradeAlert(alert);
        alerts.push(alert);
      }

      const index = nextTrades.findIndex((item) => item.id === trade.id);
      if (index !== -1) {
        nextTrades[index] = result.trade;
      }
    }

    if (alerts.length > 0) {
      this.store.saveTrades(nextTrades);
    }

    this.lastCheckAt = new Date().toISOString();

    await this.maybeRunHealthChecks(activeTrades);
    return alerts;
  }

  async maybeRunHealthChecks(activeTrades) {
    const config = this.monitorConfigStore?.load();
    if (!config?.healthEnabled || !this.assistant) {
      return [];
    }
    const now = Date.now();
    const dueTrades = activeTrades.filter((trade) => {
      const lastHealthAt = Date.parse(trade.alerts?.lastHealthCheckAt ?? "");
      return !Number.isFinite(lastHealthAt) || now - lastHealthAt >= config.healthIntervalMs;
    });
    if (dueTrades.length === 0) {
      return [];
    }
    return this.runHealthChecks(dueTrades);
  }

  async runHealthChecks(inputTrades = null) {
    if (!this.assistant) {
      throw new Error("AI assistant is not configured for health checks");
    }

    const trades = this.store.loadTrades();
    const activeTrades =
      inputTrades ?? trades.filter((trade) => trade.status === "active");
    const nextTrades = [...trades];
    const alerts = [];

    for (const trade of activeTrades) {
      const checkedAt = new Date().toISOString();
      let report;
      let health;
      try {
        report = await this.client.buildSymbolReport(trade.symbol);
        health = await this.assistant.checkTradeHealthJson({
          trade,
          symbolReport: report,
        });
        this.healthLogger?.log({
          tradeId: trade.id,
          symbol: trade.symbol,
          request: { trade, symbolReport: report },
          response: health,
        });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.healthLogger?.log({
          tradeId: trade.id,
          symbol: trade.symbol,
          error: this.lastError,
        });
        continue;
      }

      const normalizedStatus = String(health.status ?? "valid").toLowerCase();
      const status =
        normalizedStatus === "invalid" || normalizedStatus === "weakening"
          ? normalizedStatus
          : "valid";
      const previousStatus = trade.alerts?.lastHealthStatus ?? null;
      const notify = Boolean(health.notify) && status !== "valid";
      const statusChanged = previousStatus !== status;
      const nextTrade = structuredClone(trade);
      nextTrade.alerts ??= {};
      nextTrade.alerts.lastHealthCheckAt = checkedAt;
      nextTrade.alerts.lastHealthStatus = status;

      const index = nextTrades.findIndex((item) => item.id === trade.id);
      if (index !== -1) {
        nextTrades[index] = nextTrade;
      }

      if (notify && statusChanged) {
        const alert = {
          type: `health_${status}`,
          symbol: trade.symbol,
          side: trade.side,
          currentPrice: formatPrice(report.markPriceUsd),
          summary: health.summary,
          reasons: Array.isArray(health.reasons) ? health.reasons.map(String) : [],
          suggestedAction: health.suggestedAction,
        };
        try {
          await this.notifier.sendTradeAlert(alert);
          alerts.push(alert);
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.healthLogger?.log({
            tradeId: trade.id,
            symbol: trade.symbol,
            notificationError: this.lastError,
            alert,
          });
        }
      }
    }

    this.store.saveTrades(nextTrades);
    this.lastHealthCheckAt = new Date().toISOString();
    return alerts;
  }
}
