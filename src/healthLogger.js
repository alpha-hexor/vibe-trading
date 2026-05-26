import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DATA_DIR = path.resolve(process.cwd(), ".data");
const HEALTH_LOG_FILE = path.join(DATA_DIR, "health-checks.log");

export class HealthLogger {
  constructor({ enabled = false } = {}) {
    this.enabled = enabled;
  }

  log(entry) {
    if (!this.enabled) {
      return;
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      HEALTH_LOG_FILE,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  }
}

export { HEALTH_LOG_FILE };
