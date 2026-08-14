-- Add payee column to expenses table
ALTER TABLE public.expenses 
ADD COLUMN IF NOT EXISTS payee TEXT;

-- Create index on payee for fast autocomplete & filtering
CREATE INDEX IF NOT EXISTS idx_expenses_payee ON public.expenses(user_id, payee);

-- Update recent_expenses view to include payee column
DROP VIEW IF EXISTS public.recent_expenses;
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

-- Grant permissions to authenticated users
GRANT SELECT ON public.recent_expenses TO authenticated;
