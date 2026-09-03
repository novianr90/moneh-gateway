# Architecture Decision Records (ADR): `moneh-gateway`

**Project:** Moneh Gateway
**Base Docs:** [ARCHITECTURE.md](ARCHITECTURE.md), [DATABASE.md](DATABASE.md), [TECHNICAL-SPECIFICATION.md](TECHNICAL-SPECIFICATION.md)

---

## ADR-001: Decoupled Fastify API Gateway (`moneh-gateway`)

- **Status:** Accepted
- **Context:** Direct browser-to-Supabase connections expose credentials, and third-party integrations (Actual Budget SDK) cannot run in a browser environment.
- **Decision:** Extract all backend communication, auth cookies, business logic, and third-party SDKs into a dedicated Fastify API Gateway, separate from the `tracker-moneh` SvelteKit frontend.
- **Consequences:**
  - Zero sensitive credentials exposed on the frontend client.
  - Unified REST API surface for all frontend consumers.
  - Gateway owns the Supabase migrations (`supabase/migrations/`) as source of truth.

---

## ADR-002: Saga Dual-Write & Background Reconciliation for Actual Budget

- **Status:** Accepted
- **Context:** Synchronizing expense records with Actual Budget (Financial System of Record) without distributed transactions risks partial writes, network timeouts, and ledger divergence. Supabase and Actual Budget are independent, un-coordinated systems.
- **Decision:** Implement a 4-phase Saga flow with client-side idempotency (`idempotency_key`), durable payee side-effects, explicit state transitions (`PENDING`, `SYNCED`, `ROLLBACK_PENDING`, `SYNC_FAILED`, `RECONCILIATION_REQUIRED`), correlation identifiers embedded in the Actual transaction's `notes` field, and an automated background reconciliation engine matching on those identifiers.
- **Consequences:**
  - Resilient dual-write with no duplicate transactions in Actual Budget under normal failure modes.
  - Transient network blips self-heal via background reconciliation instead of manual intervention.
  - Full flow detail: [ACTUAL_BUDGET_INTEGRATION.md](ACTUAL_BUDGET_INTEGRATION.md) §5–§8.

---

## ADR-003: Feature Flagging for Actual Budget (`USE_ACTUAL`)

- **Status:** Accepted
- **Context:** The gateway may need to run before Actual Budget ledger balances are ready to receive writes, while master data sync and Google Sheets reporting stay active.
- **Decision:** Environment-driven feature flag `USE_ACTUAL=false|true`, gating only the Actual Budget write path.
- **Consequences:** Gateway runs standalone without Actual writes when disabled; zero-code activation when ready.

---

## ADR-004: Multi-User, Multi-Budget via `users_configurations`

- **Status:** Accepted
- **Tracks:** issue #2
- **Context:** `ACTUAL_SYNC_ID` was originally a gateway-wide env var — one Gateway instance could only ever write to one Actual Budget, blocking multiple Tracker users from having their own budgets.
- **Decision:** Move `actual_sync_id` into `users_configurations` (one row per user, RLS-scoped), resolved per authenticated request instead of read from env. The Actual Budget SDK's single active-budget-per-process pointer is switched (`downloadBudget`) whenever the resolved `actual_sync_id` differs from the currently active one.
- **Consequences:**
  - One Gateway + one Actual host now serves many users, each against their own budget.
  - `USE_ACTUAL=true` with no `actual_sync_id` configured degrades gracefully (warning, not error) rather than failing.
  - Detail: [features/multi-user-multi-budget.md](features/multi-user-multi-budget.md).

---

## ADR-005: Soft-Deactivation Master Data Sync (`is_active`)

- **Status:** Accepted
- **Context:** Hard-deleting categories or payment methods in Supabase when syncing from Actual Budget would violate the `on delete restrict` FK from historical `expenses`.
- **Decision:** `is_active BOOLEAN NOT NULL DEFAULT true` on `categories` and `payment_methods`. Master-data sync activates items present in Actual Budget and deactivates ones no longer present, never deletes.
- **Consequences:** Historical expenses keep valid references with zero data loss; entry dropdowns filter to active items only.

---

## ADR-006: Auto-Adjust Bills on Next-Month for Credit Card / Paylater Accounts

- **Status:** Accepted
- **Tracks:** issue #7
- **Context:** A credit-card/paylater transaction's actual cash outflow happens at the bill due date, not at the moment of purchase. Without adjustment, the budget doesn't reflect the upcoming bill until the user manually accounts for it.
- **Decision:** Flag eligible payment methods (`payment_methods.is_credit_card`) and let each user designate a Bills category (`users_configurations.bills_category_id`). On a **new** successful Actual transaction against a flagged account, bump that category's budgeted amount for the following month by the transaction amount (`actualService.adjustNextMonthBudget`), best-effort and non-blocking. Concurrent adjustments for the same user's budget are serialized via an in-process mutex, since `setBudgetAmount` writes an absolute value rather than an increment.
- **Consequences:**
  - Upcoming bill payments are pre-loaded into next month's budget automatically.
  - A failure here never fails expense creation — the underlying Actual transaction already succeeded.
  - Known gap: editing/deleting a synced credit-card expense does not reverse the earlier bump (follow-up).
  - Detail: [features/auto-adjust-bills-credit-card.md](features/auto-adjust-bills-credit-card.md).

---

## ADR-007: `PATCH /api/payment-methods/:id` Restricted to `is_credit_card`

- **Status:** Accepted
- **Context:** `payment_methods.name` and `.is_active` are one-way synced FROM Actual Budget accounts (`syncMasterDataToSupabase`) — there is no reverse sync. Allowing them to be edited from Supabase would let the two systems silently drift.
- **Decision:** The update endpoint accepts and writes only `is_credit_card`, a Supabase-only field with no Actual Budget equivalent. `name`/`is_active` remain sync-managed, not user-editable via this route.
- **Consequences:** No accidental divergence between Supabase's payment method record and its Actual Budget account; the only per-account setting a user manages directly is the credit-card flag.
