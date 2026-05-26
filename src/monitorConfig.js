import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DATA_DIR = path.resolve(process.cwd(), ".data");
const MONITOR_FILE = path.join(DATA_DIR, "monitor.json");
const DEFAULT_HEALTH_INTERVAL_MS = 5 * 60 * 1000;

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

export class MonitorConfigStore {
  load() {
    const stored = readJsonFile(MONITOR_FILE, {});
    return {
      healthEnabled: Boolean(stored.healthEnabled),
      healthIntervalMs: Number.isFinite(Number(stored.healthIntervalMs))
        ? Number(stored.healthIntervalMs)
        : DEFAULT_HEALTH_INTERVAL_MS,
    };
  }

  save(config) {
    const next = {
      ...this.load(),
      ...config,
    };
    writeJsonFile(MONITOR_FILE, next);
    return next;
  }

  setHealthEnabled(enabled) {
    return this.save({ healthEnabled: Boolean(enabled) });
  }
}

export { DEFAULT_HEALTH_INTERVAL_MS };
