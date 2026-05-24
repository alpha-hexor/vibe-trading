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

  clearHistory() {
    this.history = [];
  }
}
