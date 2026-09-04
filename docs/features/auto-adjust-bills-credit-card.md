# PRD: Auto-Adjust Bills on Next-Month (Credit Card / Paylater)

**Tracks:** issue #7
**Status:** Shipped (creation path only — see Known Gaps)

---

## Goal

When a user creates a new transaction using a Credit Card / paylater account, the budget for the configured Bills-related category is automatically increased for **next month**, so the upcoming bill payment is already reflected in the budget before it's due.

## Current Behavior (before this feature)

- `payment_methods` table (Supabase) has no field/flag to mark an account as "Credit Card / paylater".
- Transactions made with a credit-card account are written to Actual Budget the same as any standard transaction — no side effect on any other category's budget.
- The "Bills" category is not configurable; there is no per-user setting pointing at which category represents Bills.

## Expected Behavior

Transactions created against a payment method flagged as credit-card/paylater automatically increase the budgeted amount of the user-configured Bills category, for the month *after* the transaction's expense date.

---

## Implementation Notes

### Schema

```sql
ALTER TABLE public.payment_methods
    ADD COLUMN IF NOT EXISTS is_credit_card boolean not null default false;

ALTER TABLE public.users_configurations
    ADD COLUMN IF NOT EXISTS bills_category_id uuid references public.categories(id) on delete set null;
```

- `is_credit_card` is Supabase-only — not synced to/from Actual Budget's account model (Actual has no such concept).
- `bills_category_id` is nullable; unconfigured means the feature is a no-op for that user (skipped silently, not an error).

Full field list: [DATABASE.md §2.2 / §2.5](../DATABASE.md#22-publicpayment_methods).

### Adjustment Logic (`actualService.adjustNextMonthBudget`)

```text
adjustNextMonthBudget(actualSyncId, categoryName, amount, expenseDate):
  1. resolveCategoryId(categoryName) -> categoryId
     (throws ACT008 if the category no longer exists in Actual Budget)
  2. nextMonth = expenseDate's month + 1, formatted "YYYY-MM"
  3. within actualApi.batchBudgetUpdates(...) AND a per-actualSyncId mutex:
       currentBudgeted = getBudgetMonth(nextMonth).categoryGroups[].categories[].budgeted for categoryId (0 if absent)
       newBudgeted = currentBudgeted + Math.round(amount * 100)
       setBudgetAmount(nextMonth, categoryId, newBudgeted)
```

No validation on the resulting value — this works even when the current budgeted amount is 0.

**Concurrency:** `setBudgetAmount` writes an absolute value, not an increment, so two concurrent credit-card transactions for the same user could otherwise race on the read-then-write and lose an update. `adjustNextMonthBudget` serializes calls per `actualSyncId` through an in-process promise-chain mutex (`withBudgetMutex`) before entering `batchBudgetUpdates`, so concurrent adjustments for the same user's budget are applied one at a time. This protects against races within a single gateway process; it does not span multiple gateway instances.

### Hook Points

The adjustment is best-effort and non-blocking — a failure here is logged (`console.warn`) and never fails the expense operation, since the underlying transaction already synced successfully to Actual. It fires from `expenseService.adjustBillsBudgetIfCreditCard`, called after a **new** Actual transaction is successfully created:

| Call site | When |
| :--- | :--- |
| `expenseService.createExpense` (Phase 3 success) | New expense synced to Actual for the first time. |
| `expenseService.retryDefiniteFailure` | `DEFINITE_FAILURE` retry succeeds in creating the Actual transaction. |
| `reconciliationService.reconcileExpenses` (stale `PENDING` → direct write) | Reconciliation successfully creates a new Actual transaction. |

It deliberately does **not** fire from reconciliation's "matched existing transaction via correlation" branch — that path discovers a transaction that was already created (and already had its adjustment applied, or was created before this feature existed), so re-triggering there would double-count the budget bump.

Each call site resolves eligibility the same way:
1. Look up `payment_methods.is_credit_card` for the expense's `payment_method` (by name) + `user_id`. Skip if `false`/not found.
2. Look up `users_configurations.bills_category_id` for the user. Skip silently if not configured.
3. Resolve the Bills category's name from Supabase `categories`, then call `adjustNextMonthBudget(actualSyncId, categoryName, expense.amount, expense.expense_date)`.

### Configuration API

- `PATCH /api/payment-methods/:id` — toggles `is_credit_card` only; no other field is updatable via this endpoint. `name` and `is_active` are one-way synced FROM Actual Budget (see [DECISIONS.md ADR-007](../DECISIONS.md#adr-007-patch-apipayment-methodsid-restricted-to-is_credit_card)) with no reverse sync path — allowing edits to them from Supabase would silently drift from the Actual account they mirror. `is_credit_card` is safe because it's a Supabase-only concept; Actual has no equivalent flag.
- `GET /api/config` — now includes `billsCategoryId`.
- `PUT /api/config/bills-category` — set/clear `bills_category_id`.

---

## Known Gaps / Follow-Ups

- **Update/Delete of a synced credit-card expense**: this feature only covers the *creation* path per Acceptance Criteria. Editing the amount or deleting a synced credit-card expense does **not** currently reverse/adjust the Bills budget — the earlier bump stays in place. Flagged as a follow-up issue.
- **Cross-process concurrency**: the mutex above is per gateway process; running multiple gateway instances against the same Actual budget could still race. Not a concern at current deployment scale (single instance).
- **Retry/reconciliation paths**: covered (see Hook Points table) to avoid missed adjustments on those paths too.

---

## Acceptance Criteria

- [x] `payment_methods.is_credit_card` flag added, toggleable via API
- [x] `users_configurations.bills_category_id` added, configurable via API (dashboard-driven, not hardcoded)
- [x] Creating a transaction on a credit-card-flagged account increases next month's Bills category budget by the transaction amount, with no validation (works even when current budgeted is 0)
- [x] Standard (non-credit-card) transactions unaffected
- [x] Budget-adjustment failure does not fail expense creation (best-effort, warning-only)
- [x] Verified `tsc` check, run build local
- [ ] Verified on development environment
- [ ] Passed all test case on development environment
