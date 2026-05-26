import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ENV_FILE = path.resolve(process.cwd(), ".env");

function loadDotEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    return;
  }

  const content = fs.readFileSync(ENV_FILE, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] ?? "").trim());
}

export function getConfig() {
  return {
    openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    openRouterModel:
      process.env.OPENROUTER_MODEL ?? "anthropic/claude-3.7-sonnet",
    openRouterSiteUrl: process.env.OPENROUTER_SITE_URL ?? "http://localhost",
    openRouterAppName: process.env.OPENROUTER_APP_NAME ?? "Claude Future",
    exchange: process.env.COINSWITCH_EXCHANGE ?? "BYBIT",
    debug: envFlag("DEBUG"),
  };
}
