# super-bot

Autonomous crypto trading bot. Uses Claude AI to analyze technical indicators and execute spot trades on Binance every 5 minutes.

## Status

Working. Runs on mainnet with real money.

## What it does

Every 5 minutes:
1. Fetches klines (15m, 1h, 4h), 24h ticker, and order book for each pair
2. Computes RSI, MACD, EMA (9/21/50), Bollinger Bands, ATR, volume ratio locally
3. Sends all data + portfolio state + recent trades to Claude
4. Claude returns JSON with BUY/SELL/HOLD decisions per pair
5. Risk management validates and caps each decision
6. Approved trades execute as market orders on Binance

## Trading pairs

BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, ADAUSDT

Configurable in `src/config/index.ts`.

## Risk management (hardcoded)

- Max 25% of portfolio per coin
- Max 80% total deployment (20% always in cash)
- Min trade: $12
- 15 min cooldown after selling a pair before buying it back
- Halts all trading if portfolio drops >5% in a day

## Setup

```bash
npm install
cp .env.example .env
```

Fill `.env`:

```
BINANCE_API_KEY=your_key
BINANCE_API_SECRET=your_secret
ANTHROPIC_API_KEY=your_key
```

Binance API key needs spot trading permissions enabled.

## Run

```bash
npm start
```

Runs the first cycle immediately, then every 5 minutes via cron.

## Dev

```bash
npm run dev       # watch mode with tsx
npm run typecheck # type check without emitting
```

## Project structure

```
src/
  config/index.ts           - env vars, pairs, risk params, schedule
  types/index.ts            - all DTOs and interfaces
  services/
    binance.service.ts      - Binance API (market data + orders)
    analysis.service.ts     - technical indicators from klines
    claude.service.ts       - builds prompt, calls Claude, parses response
    portfolio.service.ts    - tracks positions, cost basis, trade history
    risk.service.ts         - validates decisions against risk rules
    trading.service.ts      - executes approved orders
  bot.ts                    - cycle orchestrator
  index.ts                  - entry point + cron
data/                       - trade history, portfolio snapshots (gitignored)
```

## Data

Trade history and daily snapshots persist to `data/` as JSON. Survives restarts. Gitignored.
