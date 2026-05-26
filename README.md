# Vibe Trading

Vibe Trading is a terminal-based research assistant for CoinSwitch futures markets(Public API). It fetches live futures data, computes common technical indicators, scans for potential long/short setups, and uses OpenRouter to answer trading questions with current market context.

> **Disclaimer**
>
> This project is for research, learning, and personal workflow experimentation only. Do **not** trust its output blindly for real investments or live trades. Market data, indicators, AI-generated analysis, and monitor alerts can be delayed, incomplete, wrong, or inappropriate for your risk profile. Always verify independently, use your own judgment, and consult a qualified financial professional where needed. This tool does not provide financial advice and does not place or close orders.

## What It Does

- Runs an interactive terminal REPL with slash commands and plain-language questions.
- Pulls CoinSwitch futures market data and symbol-level reports.
- Calculates EMA 9/21/50, SMA 20, RSI 14, MACD 12/26/9, ATR 14, support, and resistance.
- Scans the market for potential long and short setups.
- Uses OpenRouter for natural-language analysis, daily target planning, and structured trade drafts.
- Saves monitored trade plans locally and sends Discord or Telegram notifications.
- Optionally runs AI health checks that classify active trade setups as `valid`, `weakening`, or `invalid`.

## Important Safety Notes

- This is **notification-only**. It does not execute trades.
- Futures trading is high risk, especially with leverage.
- AI responses are probabilistic and may sound confident even when they are wrong.
- Scanner output and technical indicators are not predictions.
- Treat every generated plan as a draft that needs manual review.
- Keep API keys, bot tokens, and webhook URLs out of Git commits.

## Requirements

- Node.js 18 or newer
- npm
- An OpenRouter API key for AI-backed commands
- Optional: a Discord webhook URL or Telegram bot token/chat ID for monitor alerts

## Installation

```bash
git clone <your-repo-url>
cd <directory-name>
npm install
cp .env.example .env
```

Edit `.env` and set at least:

```bash
OPENROUTER_API_KEY=your_openrouter_key
```

Optional configuration:

```bash
OPENROUTER_MODEL=deepseek/deepseek-v4-pro
OPENROUTER_SITE_URL=http://localhost
OPENROUTER_APP_NAME=Vibe Trading
COINSWITCH_EXCHANGE=BYBIT
DEBUG=false
DISCORD_WEBHOOK_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

## Run

```bash
npm run start
```

Check JavaScript syntax:

```bash
npm run check
```

## Quick Start

After launching the CLI:

```text
/market 10
/scan 8
/symbol BTCUSDT
/graph BTCUSDT
/ask What are the strongest futures setups right now?
```

You can also type normal questions without `/ask`; the assistant will gather relevant market context when needed.

## Command Reference

### Market Research

| Command | Description |
| --- | --- |
| `/market [limit]` | Show top liquid futures contracts. |
| `/scan [limit]` | Scan live markets for possible long/short setups. |
| `/symbol <symbol>` | Show a full technical report for one symbol. |
| `/graph <symbol>` | Show a 24h terminal price chart. |
| `/plan <daily_target_inr>` | Ask for a futures plan around a daily INR target. |
| `/ask <question>` | Ask OpenRouter with live market context. |

### Session

| Command | Description |
| --- | --- |
| `/help` | Show available commands. |
| `/memory` | Show remembered session context. |
| `/clear` | Clear chat memory. |
| `/exit` or `/quit` | Quit the CLI. |

### Notifications

| Command | Description |
| --- | --- |
| `/notification status` | Show Discord and Telegram setup status. |
| `/notification discord <webhook_url>` | Configure Discord alerts. |
| `/notification telegram <bot_token> <chat_id>` | Configure Telegram alerts. |
| `/notification test` | Send a test notification. |
| `/notification clear` | Clear saved notification settings. |

### Trade Plans

| Command | Description |
| --- | --- |
| `/trade draft <finalized_trade_plan>` | Convert a plan into a structured monitored-trade draft. |
| `/trade confirm` | Save the latest draft as an active monitored trade. |
| `/trade list` | List saved trades. |
| `/trade show <id>` | Show one saved trade. |
| `/trade details <id>` | Show a live chart with entry, stop, and targets overlaid. |
| `/trade pause <id>` | Pause a monitored trade. |
| `/trade resume <id>` | Resume a paused trade. |
| `/trade close <id>` | Mark a trade as closed. |
| `/trade remove <id>` | Delete a trade permanently. |

### Monitor

| Command | Description |
| --- | --- |
| `/monitor start [15s]` | Start monitoring active trades. |
| `/monitor status` | Show monitor status. |
| `/monitor check` | Run one immediate monitor check. |
| `/monitor stop` | Stop monitoring. |
| `/monitor health status` | Show AI health-check status. |
| `/monitor health on` | Enable AI setup-validity checks every 5 minutes. |
| `/monitor health off` | Disable AI health checks. |
| `/monitor health check` | Run one immediate AI health check. |

Accepted monitor intervals:

```text
10s, 15s, 30s, 60s, 1m, 5m
```

The minimum interval is `10s`; the maximum interval is `5m`.

## Trade Monitor Workflow

The monitor watches saved trade plans and sends alerts when live price reaches an entry zone, target, near-stop warning, or stop loss. It does not interact with an exchange account.

### 1. Configure Alerts

Discord:

```bash
/notification discord https://discord.com/api/webhooks/...
```

Telegram:

```bash
/notification telegram <bot_token> <chat_id>
```

Verify:

```bash
/notification status
/notification test
```

### 2. Draft And Confirm A Trade

```bash
/trade draft long BTC around 76000, stop 74800, sell 50% at 77200 and rest 50% between 78200-78600
```

Review the structured draft in the terminal. If it looks correct:

```bash
/trade confirm
```

### 3. Start Monitoring

```bash
/monitor start 15s
```

Pause or resume trades any time:

```bash
/trade pause trade_abcd1234
/trade resume trade_abcd1234
```

## AI Health Checks

Price monitoring is deterministic and runs at your chosen monitor interval. AI health checks are separate. When enabled, the assistant reviews each active trade with fresh market context every 5 minutes and sends a notification only when the setup becomes `weakening` or `invalid`.

Enable health checks:

```bash
/monitor health on
```

Run one check immediately:

```bash
/monitor health check
```

Disable health checks:

```bash
/monitor health off
```

For development debugging, set:

```bash
DEBUG=true
```

Health-check prompts and model results are appended to:

```text
.data/health-checks.log
```

## Local Data

This application stores local runtime data under `.data/`, including trade state, notification configuration, monitor settings, and optional debug logs. Do not commit sensitive local data.

## Feedback And Improvements

Feedback, bug reports, improvement ideas, and opinionated suggestions are welcome. If you try this project and notice confusing output, missing commands, weak analysis, risky assumptions, or workflow improvements, please open an issue or discussion on GitHub.

Useful feedback includes:

- Bugs or crashes with steps to reproduce.
- Ideas for better risk warnings or safer defaults.
- Suggestions for new indicators, exchanges, notification channels, or monitor rules.
- Opinions on the CLI flow, prompts, trade-draft format, or README clarity.

## License

No license has been specified yet. Add one before publishing if you want others to use, modify, or redistribute this project.
