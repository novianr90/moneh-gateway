-- Add payee column to expenses table
ALTER TABLE public.expenses 
ADD COLUMN IF NOT EXISTS payee TEXT;

-- Create index on payee for fast autocomplete & filtering
CREATE INDEX IF NOT EXISTS idx_expenses_payee ON public.expenses(user_id, payee);

-- Drop recent_expenses view with cascade to handle dependent functions
DROP VIEW IF EXISTS public.recent_expenses CASCADE;

-- Recreate recent_expenses view with security_invoker = true
CREATE VIEW public.recent_expenses WITH (security_invoker = true) AS
SELECT 
    e.id,
    e.user_id,
    e.amount,
    e.category_id,
    c.name AS category_name,
    c.icon AS category_icon,
    c.color AS category_color,
    e.payment_method,
    e.payee,
    e.description,
    e.expense_date,
    e.is_upload,
    e.actual_transaction_id,
    e.sync_status,
    e.sync_failure_type,
    e.sync_error,
    e.synced_at,
    e.idempotency_key,
    e.created_at,
    e.updated_at
FROM public.expenses e
LEFT JOIN public.categories c ON e.category_id = c.id;

-- Recreate RPC function depending on recent_expenses view using plpgsql
CREATE OR REPLACE FUNCTION public.get_recent_transactions(p_limit integer DEFAULT 10)
RETURNS SETOF public.recent_expenses
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
    RETURN QUERY
    SELECT *
    FROM public.recent_expenses
    WHERE user_id = auth.uid()
    ORDER BY expense_date DESC, id DESC
    LIMIT p_limit;
END;
$$;

-- Grant permissions to authenticated users
GRANT SELECT ON public.recent_expenses TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_recent_transactions(integer) TO authenticated;
