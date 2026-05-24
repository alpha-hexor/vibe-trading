export class SessionMemory {
  constructor() {
    this.turns = [];
    this.preferences = new Map();
  }

  addTurn(role, text) {
    this.turns.push({ role, text, timestamp: new Date().toISOString() });
    if (this.turns.length > 20) {
      this.turns = this.turns.slice(-20);
    }
    if (role === "user") {
      this.extractPreferences(text);
    }
  }

  extractPreferences(text) {
    const lower = text.toLowerCase();
    const amountMatch = text.match(
      /(?:i have|my account(?: size| balance)? is|account(?: size| balance)?|capital(?: available)?|margin(?: available)?|budget|balance|with)\s*(?:of\s*)?(?:₹|rs\.?\s*|inr\s*)?(\d[\d,]*(?:\.\d+)?)/i,
    );
    if (amountMatch) {
      this.preferences.set(
        "capital_inr",
        Number(amountMatch[1].replaceAll(",", "")),
      );
    }

    if (/\b(low risk|safe|conservative)\b/.test(lower)) {
      this.preferences.set("risk_profile", "conservative");
    } else if (/\b(high risk|aggressive|degen)\b/.test(lower)) {
      this.preferences.set("risk_profile", "aggressive");
    } else if (/\bmoderate\b/.test(lower)) {
      this.preferences.set("risk_profile", "moderate");
    }

    const symbolMatch = text.match(/\b([A-Za-z]{2,12}USDT)\b/);
    if (symbolMatch) {
      this.preferences.set("focus_symbol", symbolMatch[1].toUpperCase());
    }
  }

  buildSummary() {
    const summary = {};
    for (const [key, value] of this.preferences.entries()) {
      summary[key] = value;
    }
    const recentTurns = this.turns.slice(-6).map((turn) => ({
      role: turn.role,
      text: turn.text,
    }));
    return {
      preferences: summary,
      recentTurns,
    };
  }

  clear() {
    this.turns = [];
    this.preferences.clear();
  }
}
