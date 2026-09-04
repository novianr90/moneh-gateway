# PRD: Multi-User, Multi-Budget Support

**Tracks:** issue #2
**Status:** Shipped

---

## Goal

1 Tracker, 1 Gateway, 1 Actual Budget host, serving multiple users — each user's expenses sync to *their own* Actual Budget, not a single shared one.

## Current Behavior (before this feature)

`ACTUAL_SYNC_ID` is set as a Gateway environment variable, so one Gateway instance can only ever access one Actual Budget.

## Problem

This prevents multiple users from having their expenses tracked against their own Actual Budget — supersedes the single gateway-wide `ACTUAL_SYNC_ID` model described in [ACTUAL_BUDGET_INTEGRATION.md §9](../ACTUAL_BUDGET_INTEGRATION.md#9-actual-budget-sdk-lifecycle-management)'s original design.

## Expected Behavior

- Create `users_configurations` table containing `user_id` + `actual_sync_id`.
- Remove `ACTUAL_SYNC_ID` from Gateway environment variables.
- Resolve `actual_sync_id` from `users_configurations` using the authenticated user's `user_id`.
- Initialize/use the Actual Budget dynamically based on the authenticated user.

---

## Implementation Notes

### Schema

```sql
CREATE TABLE public.users_configurations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade unique,
    actual_sync_id text unique,  -- nullable: "not configured yet" is a valid state
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
```

RLS: each user may `SELECT` / `INSERT` / `UPDATE` only their own row (`auth.uid() = user_id`). Full field list: [DATABASE.md §2.5](../DATABASE.md#25-publicusers_configurations).

### Resolution Rule

For every Actual Budget operation, the Gateway resolves availability per authenticated user (`userConfigService.resolveActualAvailability`) instead of reading a single env var:

| `USE_ACTUAL` (env) | `users_configurations.actual_sync_id` | Result |
| :--- | :--- | :--- |
| `false` | — | Actual sync disabled. No warning (feature intentionally off). |
| `true` | blank / not set | Treated **as if `USE_ACTUAL=false`** for that user: expenses still save to Supabase as `PENDING`, no Actual write attempted. Response includes `warning: "Your Actual sync ID is empty. Please set it up on the configuration page."` |
| `true` | set | Normal Saga dual-write flow ([ACTUAL_BUDGET_INTEGRATION.md §6](../ACTUAL_BUDGET_INTEGRATION.md#6-saga-based-dual-write--sequence-flows)), using that user's `actual_sync_id` to resolve the active budget. |

Applies uniformly to: expense create/update/delete/retry, payee listing, master-data sync, and sync-status reporting.

### Background Reconciliation

The reconciliation engine ([ACTUAL_BUDGET_INTEGRATION.md §7.3](../ACTUAL_BUDGET_INTEGRATION.md#73-background-reconciliation-engine)) scans `expenses` across **all** users. It resolves `actual_sync_id` per `expense.user_id` (cached per cycle) before attempting any Actual Budget lookup/write for that record. Records belonging to a user with no `actual_sync_id` configured are skipped for that cycle (logged, not treated as a failure) rather than erroring.

### Configuration API

- `GET /api/config` — current `useActual` flag + this user's `actualSyncId`.
- `PUT /api/config/actual-sync-id` — set/clear this user's `actualSyncId`.

The Tracker frontend's "configuration page" (referenced in the warning message) is expected to call these endpoints.

---

## Acceptance Criteria

- [x] `users_configurations` table created (`user_id`, `actual_sync_id`, RLS-scoped)
- [x] `ACTUAL_SYNC_ID` removed from Gateway environment variables
- [x] Actual Budget operations resolve `actual_sync_id` per authenticated user
- [x] `USE_ACTUAL=true` + unconfigured user degrades gracefully with a `warning`, not an error
- [x] Background reconciliation resolves `actual_sync_id` per `expense.user_id`
- [x] Documentation updated
