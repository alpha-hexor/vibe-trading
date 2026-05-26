function formatMessageLines(lines) {
  return lines.filter(Boolean).join("\n");
}

function actionText(alert) {
  if (alert.type === "target_hit") {
    return `Action: exit ${alert.exitPercent}%`;
  }
  if (alert.type === "stop_loss_hit") {
    return "Action: exit remaining position / trade invalidated";
  }
  if (alert.type === "near_stop_loss") {
    return "Action: watch closely, consider reducing risk";
  }
  if (alert.type === "entry_zone_entered") {
    return "Action: entry zone reached";
  }
  return "";
}

function titleForAlert(alert) {
    const titles = {
      target_hit: "Target hit",
      stop_loss_hit: "Stop loss hit",
      near_stop_loss: "Near stop loss",
      entry_zone_entered: "Entry zone entered",
      health_valid: "Setup still valid",
      health_weakening: "Setup weakening",
      health_invalid: "Setup invalid",
      monitor_started: "Monitor started",
      monitor_error: "Monitor error",
    };
  return titles[alert.type] ?? "Trade monitor alert";
}

export class Notifier {
  constructor(configStore) {
    this.configStore = configStore;
  }

  isConfigured() {
    return this.configStore.status().hasAny;
  }

  async sendText(text) {
    const config = this.configStore.load();
    const tasks = [];

    if (config.discordWebhookUrl) {
      tasks.push(
        fetch(config.discordWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
        }).then(async (response) => {
          if (!response.ok) {
            throw new Error(`Discord notification failed: ${response.status}`);
          }
        }),
      );
    }

    if (config.telegramBotToken && config.telegramChatId) {
      const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
      tasks.push(
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: config.telegramChatId,
            text,
            disable_web_page_preview: true,
          }),
        }).then(async (response) => {
          if (!response.ok) {
            throw new Error(`Telegram notification failed: ${response.status}`);
          }
        }),
      );
    }

    if (tasks.length === 0) {
      throw new Error("No notification channel configured");
    }

    await Promise.all(tasks);
  }

  async sendTest() {
    await this.sendText("Claude Future notification test: alerts are configured.");
  }

  async sendTradeAlert(alert) {
    const icon = {
      target_hit: "✅",
      stop_loss_hit: "🛑",
      near_stop_loss: "⚠️",
      entry_zone_entered: "📍",
      health_valid: "ℹ️",
      health_weakening: "⚠️",
      health_invalid: "🛑",
      monitor_started: "👀",
      monitor_error: "⚠️",
    }[alert.type] ?? "•";

    const text = formatMessageLines([
      `${icon} ${alert.symbol} ${alert.side ?? ""} ${titleForAlert(alert)}`.trim(),
      "",
      alert.currentPrice ? `Current: $${alert.currentPrice}` : "",
      alert.triggerPrice ? `Trigger: $${alert.triggerPrice}` : "",
      alert.distancePct ? `Distance: ${alert.distancePct}` : "",
      actionText(alert),
      alert.summary ? `Summary: ${alert.summary}` : "",
      alert.reasons?.length ? `Reasons: ${alert.reasons.join("; ")}` : "",
      alert.suggestedAction ? `Suggested action: ${alert.suggestedAction}` : "",
      alert.note ? `Note: ${alert.note}` : "",
    ]);

    await this.sendText(text);
  }
}
