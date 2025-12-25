# ETF Trading Bot (Prototype)

Production-minded ETF allocator with append-only ledger, deterministic stubs, and a minimal local dashboard. Supports time-based runs (hourly-capable), long-only ETFs, approval gating (default on), and a weekly macro context dump.

## Key constraints
- Time-based runs (pass `--asof YYYY-MM-DD` for EOD or `YYYY-MM-DDTHH:mm` for intra-day; default cadence weekly)
- ETFs only (default universe: SPY, QQQ, IWM, EFA, EEM, TLT, SHY, GLD)
- Max 4 positions (configurable to 3 or 4), long-only, no margin/options
- Starting capital: $250
- Orders capped by max position %, max trades/run, min cash buffer, and weekly drawdown gate
- Added rails: turnover cap per run (`maxNotionalTradedPctPerRun`), minimum hold hours (`minHoldHours`)
- Append-only ledger (`ledger/events.jsonl`) is the source of truth; run bundles stored in `runs/<runId>/...` (runId includes time, e.g., `2025-12-20T10-00`)
- Approval gating on by default (`requireApproval=true`); optional `--auto-exec` to bypass on a run
- Cadence guard: when `cadence="weekly"`, runs only proceed on `rebalanceDay` unless `--force`
- Modes: `--mode paper` (default; stub broker/data unless you opt into live data), `--mode live` (requires E*TRADE auth and etrade providers)

## Setup
```bash
npm install
```
Environment placeholders live in `.env.example` (not required for stub mode). Key vars:
- Required: `ETRADE_CONSUMER_KEY`, `ETRADE_CONSUMER_SECRET`, `FRED_API_KEY`
- Optional: `FINNHUB_API_KEY` (pulls lightweight news into llm_context)
- Optional: `LLM_API_KEY` or `OPENAI_API_KEY` (used only when `USE_REAL_LLM=true`)
- E*TRADE callback: set one of
  - `ETRADE_CALLBACK_URL=http://127.0.0.1:8787/auth/callback` (UI captures verifier)
  - or `ETRADE_CALLBACK_URL=oob` (PIN flow)
- Token storage: `TOKEN_STORE_PATH` (default `.secrets/etrade_tokens.json`), `TOKEN_STORE_ENCRYPTION_KEY` (encrypt tokens at rest)
- Overrides: `ETRADE_ENV` (`sandbox` default), `ETRADE_TOKEN_STORE` (alias for token path), `BROKER_PROVIDER` (`stub` or `etrade`), `MARKET_DATA_PROVIDER` (`stub` or `etrade`), `USE_LIVE_DATA_IN_PAPER=true` to use live quotes in paper mode
- Live vs paper:
  - Paper (default): uses stub broker/data unless `USE_LIVE_DATA_IN_PAPER=true` and providers set to `etrade`.
  - Live: set `--mode live` and `BROKER_PROVIDER=etrade`, `MARKET_DATA_PROVIDER=etrade`; requires active E*TRADE auth.
- LLM: set `USE_REAL_LLM=true` to use your OpenAI key; otherwise a deterministic stub proposer is used.
- For a clean E*TRADE auth reset:
  ```
  rm -f .secrets/etrade_tokens.json
  # ensure .env has the right env/keys and a single ETRADE_CALLBACK_URL
  npm run ui
  # visit /auth and complete the flow until status shows ACTIVE
  ```

## CLI usage
- Run one cycle (paper default):
  ```bash
  # weekly EOD run
  npm run bot:run -- --asof 2025-12-20 --strategy llm --mode paper
  # intra-day/hourly run
  npm run bot:run -- --asof 2025-12-20T10:00 --strategy llm --mode paper
  ```
  Flags: `--strategy llm|deterministic|random`, `--dry-run`, `--auto-exec` (bypass approval), `--force`, `--mode paper|live|backtest`.
- Dump only (no LLM, no orders): `npm run bot:dump -- --asof 2025-12-20`
- Trade (ensures dump exists): `npm run bot:trade -- --asof 2025-12-20T10:00 --strategy llm --mode paper`
- Print sample schedule snippets (cron/launchd): `npm run schedule:print`
- Auth helpers: `npm run auth:status`, `npm run auth:connect`, `npm run auth:renew`
- Generate reports from the ledger:
  ```bash
  npm run bot:report -- --from 2025-10-01 --to 2025-12-20
  ```
- Generate a macro/portfolio context packet (writes `context/<runId>.json`):
  ```bash
  npm run data:dump -- --asof 2025-12-20 --series SP500,CPIAUCSL,UNRATE,DGS10
  ```

Outputs per run (`runs/<runId>/`):
- `inputs.json` – config, universe, portfolio snapshot, quotes
- `proposal.json` – strategy + intent
- `risk_report.json` – approvals/blocks and exposure summary
- `orders.json` – risk-approved orders
- `fills.json` – fills after execution (empty until approved)
- `context.json` / `llm_context.json` – macro/portfolio/features packet for the LLM
- `context_meta.json` – sources + truncation info for the context packet

Ledger events append to `ledger/events.jsonl` with types: RUN_STARTED, INPUTS_WRITTEN, PROPOSAL_CREATED, RISK_EVALUATED, RUN_PENDING_APPROVAL, RUN_APPROVED, RUN_REJECTED, ORDER_PREVIEWED, ORDER_PLACED, FILL_RECORDED, RUN_COMPLETED, RUN_FAILED.

## Approval flow
1. `bot:run` performs inputs → proposal → risk.
2. If `requireApproval=true`, it stops with `RUN_PENDING_APPROVAL`. Review in the UI (http://127.0.0.1:8787). Pending runs show Approve/Reject buttons (CSRF token protected, local-only bind).
3. Approve: orders are executed via the broker; fills recorded; RUN_COMPLETED emitted. Reject: RUN_REJECTED emitted, no orders placed. With `requireApproval=false` (default), orders place immediately after risk.

## Macro dump
`npm run data:dump -- --asof <timestamp>` collects portfolio/universe/quotes and FRED series (if `FRED_API_KEY` is set) into `context/<runId>.json` (also saved into `runs/<runId>/context.json` when the run exists).

## UI
```bash
npm run ui
```
- Dashboard: current equity/drawdown/exposure and recent run statuses
- Dashboard actions: buttons to create a data dump or run a proposal now (CSRF-protected, local-only)
- Run detail: inputs, proposal, risk report, orders/fills, approval actions
- Run detail: llm_context download + meta/macro/regime summary
- Ledger: latest events
- Reports: links to generated `reports/performance.csv` and `reports/summary.json`
- Auth: `/auth/etrade` starts/finishes E*TRADE OAuth locally; tokens stored at `.tokens/etrade.json` by default
- UI binds to `127.0.0.1:${uiPort}` (default 8787). If the chosen port is blocked, it retries on an ephemeral port and logs it.

## Reporting
`npm run bot:report` recomputes performance purely from the ledger and writes:
- `reports/performance.csv` (equity, drawdown, exposure, benchmark)
- `reports/summary.json` (total return, CAGR proxy, max DD, weekly volatility proxy, turnover approximation)

## Tests
Run Jest suite (ts-jest):
```bash
npm test
```
Covers schema validation, risk blocking, seeded random determinism, and ledger approval transitions.

## Swapping the stub broker/data for E*TRADE
- Broker interface lives in `src/broker/broker.types.ts`; stub in `src/broker/broker.stub.ts`.
- Implement real E*TRADE API calls in `ETradeBroker` and return it from `getBroker` in `src/broker/broker.ts` (`BROKER_PROVIDER=etrade` with OAuth tokens present).
- Market data provider interface is in `src/data/marketData.types.ts`; stub in `src/data/marketData.stub.ts`.
- E*TRADE market data provider scaffold lives in `src/data/marketData.etrade.ts` (enable via `MARKET_DATA_PROVIDER=etrade` once OAuth is set).
- Keep ledger appends (`appendEvent`) and run artifacts identical to preserve auditability.

## Safety & reproducibility notes
- Strategies are deterministic given `asof` + config; random baseline is seeded by date.
- Risk engine enforces universe-only orders, cash buffer, max position size, max trades, drawdown gate, and blocks shorting.
- Idempotent by default: reruns for the same date require `--force`.
- Errors emit RUN_FAILED with context; LLM proposal validation failures fall back to deterministic baseline unless `--strategy llm` is forced.

## Parameters to tune quickly
- `cadence`: weekly (default) or hourly; weekly guard blocks non-rebalance-day unless `--force`.
- `requireApproval`: safety gate (default true); per-run override `--auto-exec`.
- Risk rails: `maxPositions`, `maxPositionPct`, `minCashPct`, `maxNotionalTradedPctPerRun`, `minHoldHours`, `maxWeeklyDrawdownPct`.
- Universe: `src/config/universe.json` (default ETFs). Keep tight in live trading; tests can use the full set.
- Modes: `--mode paper` + stub (default), `--mode live` + `BROKER_PROVIDER=etrade` / `MARKET_DATA_PROVIDER=etrade` (requires auth).
