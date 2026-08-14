-- Migration: Add Actual Budget Sync Fields and State Tracking to Expenses
-- Spec: moneh-gateway/docs/ACTUAL_BUDGET_INTEGRATION.md (v2.3)

-- 1. Add Actual Budget columns to public.expenses
ALTER TABLE public.expenses 
    ADD COLUMN IF NOT EXISTS actual_transaction_id TEXT,
    ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS sync_failure_type TEXT,
    ADD COLUMN IF NOT EXISTS sync_error TEXT,
    ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- 2. Add Unique constraint on idempotency_key if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'expenses_idempotency_key_key'
    ) THEN
        ALTER TABLE public.expenses ADD CONSTRAINT expenses_idempotency_key_key UNIQUE (idempotency_key);
    END IF;
END $$;

-- 3. Add Check constraints for valid statuses
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'expenses_sync_status_check'
    ) THEN
        ALTER TABLE public.expenses ADD CONSTRAINT expenses_sync_status_check 
            CHECK (sync_status IN ('PENDING', 'SYNCED', 'ROLLBACK_PENDING', 'SYNC_FAILED', 'RECONCILIATION_REQUIRED'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'expenses_sync_failure_type_check'
    ) THEN
        ALTER TABLE public.expenses ADD CONSTRAINT expenses_sync_failure_type_check 
            CHECK (sync_failure_type IS NULL OR sync_failure_type IN ('DEFINITE_FAILURE', 'RECONCILIATION_EXHAUSTED'));
    END IF;
END $$;

-- 4. Add Indexes for background reconciliation and idempotency lookup
CREATE INDEX IF NOT EXISTS idx_expenses_sync_status_updated_at ON public.expenses (sync_status, updated_at);
CREATE INDEX IF NOT EXISTS idx_expenses_idempotency_key ON public.expenses (idempotency_key);

-- 5. Recreate recent_expenses view with Actual Budget sync fields and security_invoker = true
DROP VIEW IF EXISTS public.recent_expenses CASCADE;

CREATE VIEW public.recent_expenses
WITH (security_invoker = true) AS
SELECT 
    e.id,
    e.user_id,
    e.category_id,
    e.amount,
    e.description,
    e.expense_date,
    COALESCE(e.payment_method, 'Cash') AS payment_method,
    COALESCE(e.is_upload, 'N') AS is_upload,
    e.actual_transaction_id,
    COALESCE(e.sync_status, 'PENDING') AS sync_status,
    e.sync_failure_type,
    e.sync_error,
    e.synced_at,
    e.idempotency_key,
    e.created_at,
    e.updated_at,
    c.name AS category_name,
    c.color AS category_color,
    c.icon AS category_icon
FROM public.expenses e
JOIN public.categories c ON e.category_id = c.id;

-- 6. Recreate RPC function depending on recent_expenses view
CREATE OR REPLACE FUNCTION public.get_recent_transactions(p_limit INT DEFAULT 10)
RETURNS SETOF public.recent_expenses
LANGUAGE sql SECURITY INVOKER AS $$
    SELECT *
    FROM public.recent_expenses
    WHERE user_id = auth.uid()
    ORDER BY expense_date DESC, id DESC
    LIMIT p_limit;
$$;
