# Database Specification: `moneh-gateway`

**Version:** 1.0
**Status:** Current
**Base Docs:** [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md)

---

## 1. Overview

Database is **Supabase PostgreSQL**, shared with `tracker-moneh`. `moneh-gateway/supabase/migrations/` is the source of truth for schema changes — `tracker-moneh` consumes the same project, never migrates it.

Security enforced via PostgreSQL **Row Level Security (RLS)** tied to Supabase Auth (`auth.users`); every user-owned table scopes on `auth.uid() = user_id`. All tables live in the `public` schema.

Currency (`expenses.amount`) is `bigint` — Indonesian Rupiah has no fractional cents, so integer storage avoids float rounding and keeps aggregation fast.

---

## 2. Table Definitions

### 2.1 `public.categories`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → `auth.users` | `on delete cascade` |
| `name` | `text` | unique per user |
| `icon` | `text` | default `'tag'` |
| `color` | `text` | default `'#6b7280'` |
| `is_active` | `boolean` | default `true`. Soft-deactivation flag — see [DECISIONS.md ADR-006](DECISIONS.md#adr-006-soft-deactivation-master-data-sync-is_active). |
| `created_at` | `timestamptz` | |

Auto-provisioned with 6 defaults (Food, Coffee, Transport, Bills, Entertainment, Grocery) on user signup via `handle_new_user_categories()` trigger.

### 2.2 `public.payment_methods`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → `auth.users` | `on delete cascade` |
| `name` | `text` | |
| `is_active` | `boolean` | default `true`. One-way synced FROM Actual Budget accounts. |
| `is_credit_card` | `boolean` | default `false`. Supabase-only — no Actual Budget equivalent. Toggled via `PATCH /api/payment-methods/:id` (only field that endpoint updates). See [features/auto-adjust-bills-credit-card.md](features/auto-adjust-bills-credit-card.md). |
| `created_at` | `timestamptz` | |

### 2.3 `public.expenses`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → `auth.users` | `on delete cascade` |
| `category_id` | `uuid` FK → `categories` | `on delete restrict` |
| `amount` | `bigint` | `check (amount > 0)` |
| `payee` | `text` \| `null` | |
| `description` | `text` | default `''` |
| `expense_date` | `date` | default `current_date` |
| `payment_method` | `text` | account name, mirrors `payment_methods.name` |
| `is_upload` | `text` | `'Y'`/`'N'` — Google Sheets upload flag |
| `actual_transaction_id` | `text` \| `null` | Actual Budget correlation |
| `sync_status` | `text` | `PENDING` \| `SYNCED` \| `ROLLBACK_PENDING` \| `SYNC_FAILED` \| `RECONCILIATION_REQUIRED` — see [TECHNICAL-SPECIFICATION.md §2](TECHNICAL-SPECIFICATION.md#2-synchronization-state-machine) |
| `sync_failure_type` | `text` \| `null` | `DEFINITE_FAILURE` \| `RECONCILIATION_EXHAUSTED` \| `null` |
| `sync_error` | `text` \| `null` | |
| `synced_at` | `timestamptz` \| `null` | |
| `idempotency_key` | `text` \| `null` | `UNIQUE` |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` auto-touched by trigger |

### 2.4 `public.sync_logs`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → `auth.users` | `on delete cascade` |
| `started_at` / `finished_at` | `timestamptz` | |
| `status` | `text` | `in_progress` \| `success` \| `failed` |
| `synced_count` | `integer` | default `0` |
| `error_message` | `text` \| `null` | |
| `created_at` | `timestamptz` | |

Google Sheets sync audit trail, 30-day retention (application-managed).

### 2.5 `public.users_configurations`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → `auth.users`, `unique` | `on delete cascade` |
| `actual_sync_id` | `text` \| `null`, `unique` | Nullable — "not configured yet" is a valid state. See [features/multi-user-multi-budget.md](features/multi-user-multi-budget.md). |
| `bills_category_id` | `uuid` \| `null` FK → `categories` | `on delete set null`. See [features/auto-adjust-bills-credit-card.md](features/auto-adjust-bills-credit-card.md). |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` auto-touched by trigger |

One row per user; both config fields are independently nullable/optional.

---

## 3. Views

### `public.recent_expenses`

Joins `expenses` to `categories` (`category_name`, `category_color`, `category_icon`) for list/detail rendering. `security invoker` — RLS on the underlying tables applies to the querying user.

---

## 4. RPC Functions

| Function | Returns | Purpose |
| :--- | :--- | :--- |
| `get_monthly_summary(p_month)` | `total_amount, transaction_count, prev_month_total` | Dashboard summary card |
| `get_monthly_category_breakdown(p_month)` | per-category `total_amount` | Category breakdown chart |
| `get_recent_transactions(p_limit)` | `setof recent_expenses` | Recent transactions list |
| `get_daily_expense_trends(p_month)` | `expense_date, daily_total, cumulative_total` | Daily spend trend chart |
| `get_cron_jobs()` | pg_cron job rows | Sync status page |

All `security invoker` — aggregations run under the querying user's RLS, never bypass it.

---

## 5. Migration History

| Migration | Change |
| :--- | :--- |
| `20260805000000_init_schema` | Base schema: `categories`, `expenses`, `sync_logs`, RLS, RPCs, default-category trigger |
| `20260807000000_add_is_upload_to_expenses` | `expenses.is_upload` |
| `20260807000001_add_get_cron_jobs_rpc` | `get_cron_jobs()` RPC |
| `20260810000000_add_payment_method_to_expenses` | `expenses.payment_method` |
| `20260810000001_create_payment_methods_table` | `payment_methods` table |
| `20260810000002_add_daily_expense_trends_rpc` | `get_daily_expense_trends()` RPC |
| `20260810000003_fix_recent_expenses_security_invoker` | `recent_expenses` view → `security invoker` |
| `20260814000000_add_actual_budget_sync_to_expenses` | `actual_transaction_id`, `sync_status`, `sync_failure_type`, `sync_error`, `synced_at`, `idempotency_key` |
| `20260814000001_add_is_active_to_categories_and_payment_methods` | `is_active` on `categories` + `payment_methods` |
| `20260815000000_add_payee_to_expenses` | `expenses.payee` |
| `20260828092425_create_users_configuration_table` | `users_configurations` (`actual_sync_id`) |
| `20260903070049_add_credit_card_and_bills_category` | `payment_methods.is_credit_card`, `users_configurations.bills_category_id` |
