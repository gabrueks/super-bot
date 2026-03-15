## Learned User Preferences
- When implementing from an attached plan, do not edit the plan file itself.
- Update existing plan todos in order, marking the first as in progress before proceeding through the rest.
- Prefer reliability-first implementations over aggressive behavior changes.
- When introducing a new bot mode, keep the old bot running independently in parallel without cross-impact.

## Learned Workspace Facts
- The bot codebase centers on Binance trading flows with cycle orchestration in `src/bot.ts` and scheduling in `src/index.ts`.
- Rate-limit and reliability work commonly touches `src/services/binance.service.ts`, `src/services/portfolio.service.ts`, and `src/services/market-cache.service.ts`.
- Planning artifacts are stored under `.cursor/plans/` and are often used as execution references.
