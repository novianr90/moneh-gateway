# Moneh Gateway (`moneh-gateway`)

A high-performance, resilient **Fastify API Gateway & Financial Orchestrator** for the Personal Expense Tracker ecosystem. It bridges the SvelteKit frontend client (`tracker-moneh`), Supabase PostgreSQL database, Actual Budget financial ledger (`budget.novianlabs.my.id`), and Google Sheets reporting layer.

---

## 🏛️ Gateway Architecture

```text
               Frontend Client (tracker-moneh)
                           │
                           │  REST + Session Cookies
                           ▼
                  Fastify API Gateway
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

---

## 📚 Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system layers, data mapping, correlation IDs, SDK lifecycle
- [docs/DATABASE.md](docs/DATABASE.md) — schema, tables, views, RPCs, migration history
- [docs/DECISIONS.md](docs/DECISIONS.md) — ADR log
- [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) — directory layout & layer rules
- [docs/TECHNICAL-SPECIFICATION.md](docs/TECHNICAL-SPECIFICATION.md) — state machine, error catalog, env config
- [docs/ACTUAL_BUDGET_INTEGRATION.md](docs/ACTUAL_BUDGET_INTEGRATION.md) — full Saga/reconciliation deep-dive
- [docs/features/](docs/features) — one PRD per feature/issue

---

## ✨ Core Capabilities

1. **Saga Dual-Write Orchestrator:**
   - Client-side idempotency (`idempotency_key` UUID v4).
   - Durable payee master-data side-effects in Actual Budget.
   - Resilient state machine transitions: `PENDING` $\rightarrow$ `SYNCED` / `ROLLBACK_PENDING` $\rightarrow$ `SYNC_FAILED` (`DEFINITE_FAILURE` or `RECONCILIATION_EXHAUSTED`).
2. **Automated Background Reconciliation Engine:**
   - Runs periodically (configurable via `RECONCILIATION_INTERVAL_MS`) to match pending/failed transactions against Actual Budget via correlation metadata embedded in transaction notes (`[moneh_expense_id: ...] [moneh_idempotency_key: ...]`).
3. **Master Data Smart Sync (`is_active`):**
   - One-click import and synchronization of Categories and Accounts from Actual Budget into Supabase with non-destructive soft-activation and deactivation (`is_active = true|false`).
4. **Feature Flagging (`USE_ACTUAL`):**
   - Toggle Actual Budget ledger synchronization on/off dynamically via environment variable without interrupting standard operations.
5. **Multi-User, Multi-Budget Support:**
   - One Gateway instance, one Actual Budget host, many users, each pointed at their own budget. Each user's `actual_sync_id` lives in Supabase `users_configurations` (RLS-scoped, self-service via `/api/config`) instead of a single gateway-wide `ACTUAL_SYNC_ID` env var. If `USE_ACTUAL=true` but a user hasn't configured their `actual_sync_id` yet, the Gateway behaves as if Actual sync were disabled for that user and returns a `warning` telling them to set it up. See [docs/features/multi-user-multi-budget.md](docs/features/multi-user-multi-budget.md).
6. **Google Spreadsheet Reporting Sync:**
   - Triggers Google Sheets synchronization edge function and fetches audit logs.
7. **Auto-Adjust Bills on Next-Month (Credit Card / Paylater):**
   - Transactions created against a payment method flagged `is_credit_card = true` automatically increase the user-configured Bills category's budget for the month *after* the expense date. Best-effort — never blocks expense creation. See [docs/features/auto-adjust-bills-credit-card.md](docs/features/auto-adjust-bills-credit-card.md).

---

## ⚙️ Environment Variables

Create `.env` inside `moneh-gateway`:

```env
PORT=4000
HOST=0.0.0.0
SUPABASE_URL=https://your-project.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
CLIENT_ORIGIN=https://tracker.novianlabs.my.id,http://localhost:3004,http://localhost:5173

# Feature Flag: Set to true when ready to sync with Actual Budget
USE_ACTUAL=false

# Actual Budget Configuration
# NOTE: ACTUAL_SYNC_ID is NOT set here anymore. It is per-user, stored in
# Supabase `users_configurations.actual_sync_id` and managed via /api/config
# (see "Multi-User, Multi-Budget Support" above and docs/features/multi-user-multi-budget.md).
ACTUAL_SERVER_URL=https://budget.novianlabs.my.id
ACTUAL_PASSWORD=your-actual-password
ACTUAL_DATA_DIR=./budget-data

# Reconciliation Configuration
RECONCILIATION_INTERVAL_MS=60000
RECONCILIATION_GRACE_PERIOD_MS=120000
MAX_RECONCILIATION_RETRIES=3
```

---

## 🔌 API Route Reference

### 🔐 Authentication (`/api/auth`)
* `POST /api/auth/login`: Authenticates with Supabase and sets HTTP-only session cookie.
* `POST /api/auth/logout`: Clears session cookie.
* `GET /api/auth/me`: Returns current user session.

### 💰 Expenses (`/api/expenses`)
* `POST /api/expenses`: Saga dual-write expense creation (idempotency key supported).
* `GET /api/expenses`: Paginated expense list with filters (`page`, `pageSize`, `searchKey`, `categoryId`, `paymentMethod`, `startDate`, `endDate`).
* `PUT /api/expenses/:id`: Updates an existing expense.
* `DELETE /api/expenses/:id`: Deletes an expense.
* `POST /api/expenses/:id/retry`: Triggers explicit retry for failed sync records.
* `GET /api/expenses/summary`: Monthly total, transaction count, and previous month total.
* `GET /api/expenses/category-breakdown`: Monthly category breakdown.
* `GET /api/expenses/trends`: Daily and cumulative expense velocity trend series.
* `GET /api/expenses/recent`: Recent transaction entries.

### 🏷️ Categories (`/api/categories`)
* `GET /api/categories?active_only=true`: Lists categories (optionally filtering active ones).
* `POST /api/categories`: Creates a category.
* `PUT /api/categories/:id`: Updates a category.
* `DELETE /api/categories/:id`: Deletes a category.

### 💳 Payment Methods (`/api/payment-methods`)
* `GET /api/payment-methods?active_only=true`: Lists payment methods (accounts).
* `POST /api/payment-methods`: Creates a custom payment method.
* `PATCH /api/payment-methods/:id`: Toggles a payment method's `is_credit_card` flag (only field this endpoint updates).
* `DELETE /api/payment-methods/:id`: Deletes a custom payment method.

### 🔄 Dual-Sync & Master Data (`/api/sync`)
* `POST /api/sync/actual/reconcile`: Triggers manual reconciliation engine for Actual Budget.
* `POST /api/sync/actual/master-data`: Imports & syncs Categories and Accounts from Actual Budget into Supabase with `is_active` updates. Fails with `warning`-style error if the user has no `actual_sync_id` configured.
* `GET /api/sync/actual/status`: Returns Actual Budget sync status counts. Returns `{ enabled: false, warning: "..." }` if `USE_ACTUAL=true` but the user's `actual_sync_id` is blank.
* `POST /api/sync/spreadsheet/trigger`: Triggers Google Sheets synchronization edge function.
* `GET /api/sync/logs`: Retrieves recent spreadsheet sync execution logs.
* `GET /api/sync/cron-jobs`: Retrieves scheduled pg_cron sync jobs.

### ⚙️ User Configuration (`/api/config`)
* `GET /api/config`: Returns the authenticated user's configuration (`useActual` flag, current `actualSyncId`, `billsCategoryId`).
* `PUT /api/config/actual-sync-id`: Sets/updates the authenticated user's `actual_sync_id` (their personal Actual Budget). Pass `null`/blank to clear it.
* `PUT /api/config/bills-category`: Sets/updates the authenticated user's `bills_category_id` (the category auto-adjusted for credit-card transactions). Pass `null` to clear it.

### 🩺 Health (`/api/health`)
* `GET /api/health`: Server health check status (used by Coolify).

---

## 🚀 Running Locally

```bash
# Install dependencies
npm install

# Run in development mode (hot-reload via tsx)
npm run dev

# Run TypeScript typecheck
npm run check

# Build production bundle
npm run build

# Start production server
npm start
```

---

## 🐳 Docker & Coolify Deployment

`moneh-gateway` uses a multi-stage Docker build (`node:22-alpine`):

```bash
docker build -t moneh-gateway .
docker run -p 4000:4000 --env-file .env moneh-gateway
```
