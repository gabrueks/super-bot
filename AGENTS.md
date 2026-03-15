## Learned User Preferences
- When implementing from an attached plan, do not edit the plan file itself.
- Update existing plan todos in order, marking the first as in progress before proceeding through the rest.
- Prefer reliability-first implementations over aggressive behavior changes.
- When introducing a new bot mode, keep the old bot running independently in parallel without cross-impact.

## Learned Workspace Facts
- The bot codebase centers on Binance trading flows with cycle orchestration in `src/bot.ts`, short-cycle orchestration in `src/short-bot.ts`, and parallel launch orchestration in `src/index-parallel.ts`.
- Rate-limit and reliability work commonly touches `src/services/binance.service.ts`, `src/services/portfolio.service.ts`, and `src/services/market-cache.service.ts`.
- Planning artifacts are stored under `.cursor/plans/` and are often used as execution references.
- `npm start` is configured to run the parallel runner (`src/index-parallel.ts`) so spot and short bots start together by default.
- The short bot startup logs a futures account balance precheck before running the first cycle.
