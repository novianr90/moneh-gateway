# Architecture: `moneh-gateway`

**Version:** 1.0
**Status:** Current
**Role:** Fastify API Gateway & Financial Orchestrator between `tracker-moneh` (SvelteKit UI), Supabase (PostgreSQL), Actual Budget (ledger), and Google Sheets (reporting).
**Detailed Saga/Reconciliation Spec:** [ACTUAL_BUDGET_INTEGRATION.md](ACTUAL_BUDGET_INTEGRATION.md)

---

## 1. System Layer Architecture & Role Separation

```text
               Frontend Client (tracker-moneh)
                           │
                           │  REST + Session Cookies
                           ▼
                  Fastify API Gateway
                    (moneh-gateway)
        ┌──────────────────┴──────────────────┐
        │                                     │
        ▼                                     ▼
Supabase PostgreSQL Store            Actual Budget Server
 (Auth, RLS, Views, RPCs)            (Financial System of Record)
        │                                     │
        │ Edge Function                       │ @actual-app/api SDK
        ▼                                     ▼
Google Spreadsheet Sync               Local SQLite Budget Cache
 (Reporting & Analytics)              (budget-data/ directory)
```

### Key Architectural Responsibilities
- **Actual Budget**: Financial System of Record — accounts, payees, budget categories, ledger transactions, budgeted amounts.
- **Supabase**: Tracker Operational Store & Read Model — fast UI queries, user filters, integration metadata (`actual_transaction_id`, `sync_status`, `sync_failure_type`, `sync_error`, `idempotency_key`), sync logs, per-user config (`actual_sync_id`, `bills_category_id`). Not every Tracker field needs to exist in Actual Budget.
- **moneh-gateway**: Saga orchestrator — transactional dual-writes with compensating actions, idempotent request handling, background reconciliation, per-user Actual Budget session management.

### Core Retry Safety Rule

> **A definite Actual Budget failure may be directly retried. An unresolved/ambiguous Actual Budget failure must be reconciled before any new financial transaction is created.**

Full saga sequence, sync state machine, and reconciliation algorithm: see [ACTUAL_BUDGET_INTEGRATION.md](ACTUAL_BUDGET_INTEGRATION.md) §5–§8.

---

## 2. Data Mapping (Gateway ↔ Actual Budget)

| Tracker / Gateway Entity | Actual Budget Entity | Notes |
| :--- | :--- | :--- |
| `payment_methods.name` | `Account` | One-way synced FROM Actual (`syncMasterDataToSupabase`). `is_credit_card` is Supabase-only, no Actual equivalent. |
| `categories.name` | `Category` | One-way synced FROM Actual. `bills_category_id` (on `users_configurations`) points at one of these. |
| `expenses.payee` / `description` | `Payee` | Resolved/created via idempotent payee master-data workflow. |
| `expenses.amount` | `Amount` (integer cents) | `Math.round(amount * 100)`, outflow negated. |
| `expenses.expense_date` | `date` (`YYYY-MM-DD`) | ISO date string. |

## 3. Correlation Identifiers

Every expense operation carries two identifiers, embedded in the Actual transaction's `notes` field for reconciliation lookup:

| Identifier | Purpose |
| :--- | :--- |
| `expense_id` (Supabase PK) | Business identity of the Tracker expense record. |
| `idempotency_key` | Prevents duplicate `POST /api/expenses` processing. `UNIQUE` in Supabase. |

```text
[moneh_expense_id: <expense_id>] [moneh_idempotency_key: <idempotency_key>]
```

## 4. Actual Budget SDK Lifecycle

`moneh-gateway` uses `@actual-app/api` in-process. The SDK holds a **single active budget per process** (no built-in multi-tenancy):

- `actualApi.init()` runs once per process (server URL + password, gateway-wide).
- `ensureConnected(actualSyncId)` downloads/switches the active budget per-request, based on the authenticated user's own `actual_sync_id` — see [Multi-User, Multi-Budget Support](features/multi-user-multi-budget.md).
- Budget-write operations that read-then-write (e.g. `setBudgetAmount`) are additionally serialized per `actualSyncId` via an in-process mutex — see [Auto-Adjust Bills on Next-Month](features/auto-adjust-bills-credit-card.md).

> [!WARNING]
> The active budget is a process-global pointer — two requests from different users racing on which budget is active is mitigated (re-download only on mismatch) but not eliminated. True isolation would need a serialized queue per sync id, or one SDK process per budget. Acceptable at current traffic; revisit if concurrent multi-user writes become common.

## 5. Related Docs

- [DATABASE.md](DATABASE.md) — schema, tables, RLS.
- [DECISIONS.md](DECISIONS.md) — why the gateway is shaped this way.
- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) — directory layout.
- [TECHNICAL-SPECIFICATION.md](TECHNICAL-SPECIFICATION.md) — state machine, error catalog, env config.
- [ACTUAL_BUDGET_INTEGRATION.md](ACTUAL_BUDGET_INTEGRATION.md) — full saga/reconciliation deep-dive (referenced from `tracker-moneh`'s own architecture doc).
- [features/](features) — one PRD per feature/issue.
