# Claude Future

A Claude Code-style terminal CLI for CoinSwitch futures research. It pulls live futures market data, computes technical indicators, and uses OpenRouter to answer trading questions in an interactive terminal session.

## Features

- Interactive terminal REPL with slash commands
- CoinSwitch futures market snapshot and per-symbol drilldowns
- Technical indicators: EMA 9/21/50, SMA 20, RSI 14, MACD 12/26/9, ATR 14
- Opportunity scanner for long/short setups
- OpenRouter-backed natural language analysis and daily target planning

## Setup

1. Copy `.env.example` to `.env`
2. Set `OPENROUTER_API_KEY`
3. Run:

```bash
cd /Users/apple/personal/src/claude_future
npm run start
```

## Commands

- `/help`
- `/market [limit]`
- `/scan [limit]`
- `/symbol <symbol>`
- `/plan <daily_target_inr>`
- `/ask <question>`
- `/clear`
- `/exit`

Plain text input also works and routes through the OpenRouter assistant with market context.
