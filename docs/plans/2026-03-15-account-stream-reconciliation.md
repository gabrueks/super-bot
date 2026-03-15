# Account Stream Reconciliation Plan

## Goal

Move portfolio balance updates to Binance user-data stream events, with REST as periodic reconciliation and recovery fallback.

## Current State

- Market data is stream-based.
- Account balances are REST-based with cache and stale fallback.
- A background reconciler refreshes balance cache every 5 minutes.

## Target Flow

1. Create a dedicated account-state service responsible for wallet/position cache.
2. Start Binance user-data stream at startup and process account update events.
3. Update in-memory balances from stream events in near real time.
4. Keep periodic REST reconciliation every 5-15 minutes to correct drift and recover from missed events.
5. If stream disconnects, mark account state degraded and force temporary REST reads until stream recovers.

## Required Work

- Confirm `binance-api-node` support for user-data stream in this runtime version.
- Add account stream lifecycle management (open, reconnect, shutdown).
- Define event-to-domain mapping for balance deltas.
- Add sequence and staleness checks for out-of-order or delayed events.
- Add health metrics:
  - stream_connected
  - account_state_age_ms
  - rest_reconciliation_failures
  - stream_reconnect_count

## Safety Constraints

- Never trade if both stream and REST reconciliation are unavailable and cache is older than staleness threshold.
- Keep current stale-cache fallback behavior while stream rollout is incomplete.
- Roll out behind config flag and test on paper account before production key.
