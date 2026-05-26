import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DATA_DIR = path.resolve(process.cwd(), ".data");
const NOTIFICATIONS_FILE = path.join(DATA_DIR, "notifications.json");

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

function redact(value) {
  const text = String(value ?? "");
  if (!text) {
    return "";
  }
  if (text.length <= 12) {
    return "***";
  }
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

export class NotificationConfigStore {
  load() {
    const stored = readJsonFile(NOTIFICATIONS_FILE, {});
    return {
      discordWebhookUrl:
        stored.discordWebhookUrl ?? process.env.DISCORD_WEBHOOK_URL ?? "",
      telegramBotToken:
        stored.telegramBotToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "",
      telegramChatId:
        stored.telegramChatId ?? process.env.TELEGRAM_CHAT_ID ?? "",
    };
  }

  save(config) {
    writeJsonFile(NOTIFICATIONS_FILE, config);
    return config;
  }

  setDiscord(webhookUrl) {
    const url = String(webhookUrl ?? "").trim();
    if (!/^https:\/\/discord\.com\/api\/webhooks\/.+/i.test(url)) {
      throw new Error("Discord webhook URL must start with https://discord.com/api/webhooks/");
    }
    return this.save({ ...this.load(), discordWebhookUrl: url });
  }

  setTelegram(botToken, chatId) {
    const token = String(botToken ?? "").trim();
    const id = String(chatId ?? "").trim();
    if (!token || !id) {
      throw new Error("Telegram bot token and chat id are required");
    }
    return this.save({ ...this.load(), telegramBotToken: token, telegramChatId: id });
  }

  clear() {
    this.save({});
  }

  status() {
    const config = this.load();
    return {
      discord: config.discordWebhookUrl ? redact(config.discordWebhookUrl) : "not configured",
      telegram:
        config.telegramBotToken && config.telegramChatId
          ? `${redact(config.telegramBotToken)} / ${config.telegramChatId}`
          : "not configured",
      hasAny: Boolean(
        config.discordWebhookUrl || (config.telegramBotToken && config.telegramChatId),
      ),
    };
  }
}
