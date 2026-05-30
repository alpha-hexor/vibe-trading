import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";

function extractAssistantText(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) {
    return "No assistant response returned by OpenRouter.";
  }
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => (item?.type === "text" ? item.text : ""))
      .join("\n")
      .trim();
  }
  return "No assistant response returned by OpenRouter.";
}

function extractJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Assistant did not return a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export class OpenRouterAssistant {
  constructor(config) {
    this.config = config;
    this.history = [];
  }

  buildBody({
    question,
    marketOverview = null,
    scans = null,
    symbolReport = null,
    planContext = null,
    sessionMemory = null,
    stream = false,
  }) {
    return {
      model: this.config.openRouterModel,
      temperature: 0.2,
      stream,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        ...this.history,
        {
          role: "user",
          content: buildUserPrompt({
            question,
            marketOverview,
            scans,
            symbolReport,
            planContext,
            sessionMemory,
          }),
        },
      ],
    };
  }

  async createResponse(body) {
    return fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.openRouterApiKey}`,
        "HTTP-Referer": this.config.openRouterSiteUrl,
        "X-Title": this.config.openRouterAppName,
      },
      body: JSON.stringify(body),
    });
  }

  rememberTurn(question, text) {
    this.history.push({
      role: "user",
      content: question,
    });
    this.history.push({
      role: "assistant",
      content: text,
    });
    if (this.history.length > 12) {
      this.history = this.history.slice(-12);
    }
  }

  async ask({
    question,
    marketOverview = null,
    scans = null,
    symbolReport = null,
    planContext = null,
    sessionMemory = null,
  }) {
    if (!this.config.openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY is missing. Create a .env file before using /ask or free-form chat.");
    }

    const response = await this.createResponse(
      this.buildBody({
        question,
        marketOverview,
        scans,
        symbolReport,
        planContext,
        sessionMemory,
      }),
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter request failed: ${response.status} ${errorText}`);
    }

    const payload = await response.json();
    const text = extractAssistantText(payload);
    this.rememberTurn(question, text);
    return text;
  }

  async askStream({
    question,
    marketOverview = null,
    scans = null,
    symbolReport = null,
    planContext = null,
    sessionMemory = null,
    onToken,
  }) {
    if (!this.config.openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY is missing. Create a .env file before using /ask or free-form chat.");
    }

    const response = await this.createResponse(
      this.buildBody({
        question,
        marketOverview,
        scans,
        symbolReport,
        planContext,
        sessionMemory,
        stream: true,
      }),
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter request failed: ${response.status} ${errorText}`);
    }

    if (!response.body) {
      return this.ask({
        question,
        marketOverview,
        scans,
        symbolReport,
        planContext,
        sessionMemory,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const lines = event
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"));

        for (const line of lines) {
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") {
            continue;
          }
          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          const delta = parsed?.choices?.[0]?.delta;
          const token = typeof delta?.content === "string" ? delta.content : "";
          if (token) {
            fullText += token;
            if (onToken) {
              onToken(token);
            }
          }
        }
      }
    }

    if (!fullText.trim()) {
      fullText = "No assistant response returned by OpenRouter.";
    }
    this.rememberTurn(question, fullText);
    return fullText;
  }

  async draftTradeJson({ tradeText, symbolReport = null, sessionMemory = null }) {
    if (!this.config.openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY is missing. Create a .env file before using /trade draft.");
    }

    const schema = {
      symbol: "BTCUSDT",
      side: "LONG",
      entry: { type: "price", price: 76000 },
      stopLoss: 74800,
      targets: [
        { type: "price", price: 77200, exitPercent: 50 },
        { type: "range", from: 78200, to: 78600, exitPercent: 50 },
      ],
      invalidation: ["optional condition"],
      riskNotes: ["optional risk note"],
      confidence: "low|medium|high",
      notes: "short human-readable summary",
    };

    const response = await this.createResponse({
      model: this.config.openRouterModel,
      temperature: 0.1,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You convert finalized futures trade plans into strict JSON. Return only one JSON object. Do not include markdown, comments, or prose. Do not invent missing critical prices; if a required value is missing, set it to null.",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              task: "Extract a monitored futures trade from the user text.",
              rules: [
                "symbol must be a USDT futures symbol",
                "side must be LONG or SHORT",
                "entry may be market, price, or zone",
                "targets may be price or range",
                "exitPercent values must be numeric percentages",
                "stopLoss is required",
                "return JSON matching the schema exactly",
              ],
              schema,
              userTradeText: tradeText,
              liveSymbolContext: symbolReport,
              sessionMemory,
            },
            null,
            2,
          ),
        },
      ],
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter request failed: ${response.status} ${errorText}`);
    }

    const payload = await response.json();
    return extractJsonObject(extractAssistantText(payload));
  }

  async checkTradeHealthJson({ trade, symbolReport }) {
    if (!this.config.openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY is missing. Create a .env file before using monitor health checks.");
    }

    const response = await this.createResponse({
      model: this.config.openRouterModel,
      temperature: 0.1,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You are a cautious futures trade monitor. Evaluate whether a saved trade setup is still valid using the provided live market context. Return only strict JSON, no markdown or prose.",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              task: "Evaluate trade setup health. This is monitoring guidance only, not order execution.",
              outputSchema: {
                status: "valid|weakening|invalid",
                severity: "info|warning|critical",
                confidence: "low|medium|high",
                summary: "one concise sentence",
                reasons: ["short reason"],
                suggestedAction: "hold|watch|reduce|exit|no_new_size",
                notify: true,
              },
              rules: [
                "valid means setup still broadly matches the original thesis",
                "weakening means risk is rising but stop/target may not be hit yet",
                "invalid means the setup thesis is broken or risk control should dominate",
                "Use EMA, RSI, MACD, ATR, support, resistance, 24h change, funding, and current price when available",
                "Set notify true for weakening or invalid, or for valid only if there is a material observation",
              ],
              trade,
              liveSymbolContext: symbolReport,
            },
            null,
            2,
          ),
        },
      ],
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter request failed: ${response.status} ${errorText}`);
    }

    const payload = await response.json();
    return extractJsonObject(extractAssistantText(payload));
  }

  async classifyIntentJson(userInput) {
    if (!this.config.openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY is missing. Create a .env file before using the assistant.");
    }

    const response = await this.createResponse({
      model: this.config.helperRouterModel ?? this.config.openRouterModel,
      temperature: 0.5,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a highly efficient, deterministic intent-routing assistant for a futures trading terminal. Classify the user query into a strict JSON object according to the requested schema. Return only one raw JSON object. Do not include any markdown formatting, triple backticks, comments, or extra prose.",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              task: "Classify futures trading query intent and extract potential symbols or daily target amounts in INR.",
              rules: [
                "needsScan: true if user is asking to scan, check setups, suggest opportunities, find best setups, or recommend trades. Otherwise false.",
                "needsMarketOverview: true if user is asking about the overall market state, tickers, overview, or snapshot. Otherwise false.",
                "needsPlan: true if user mentions daily income goals, account capital, budget targets, rs, inr, or planning capital. Otherwise false.",
                "symbol: a normalized futures symbol ending in 'USDT' (e.g. BTCUSDT, ETHUSDT, 1000PEPEUSDT, MEWUSDT) if a cryptocurrency is mentioned (even by its short/casually written name, like 'pepe', 'btc', 'sol', 'mew', 'doge'). Otherwise null.",
                "targetInr: a numeric value representing any INR/Rs target profit or capital sizing amount mentioned in the text. Otherwise null.",
                "isCasualGreeting: true if the query is a simple hello, hi, how are you, or general casual conversational opener. Otherwise false.",
              ],
              schema: {
                needsScan: false,
                needsMarketOverview: false,
                needsPlan: false,
                symbol: null,
                targetInr: null,
                isCasualGreeting: false,
              },
              userInput,
            },
            null,
            2,
          ),
        },
      ],
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Intent pre-classifier request failed: ${response.status} ${errorText}`);
    }

    const payload = await response.json();
    const result = extractJsonObject(extractAssistantText(payload));
    if (result && result.needsPlan === true) {
      result.needsScan = true;
      result.needsMarketOverview = true;
    }
    else if (result && result.needsScan === true) {
      result.needsMarketOverview = true;
    }  
    return result;
  }

  clearHistory() {
    this.history = [];
  }
}
