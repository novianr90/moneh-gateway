-- 1. Drop recent_expenses view with cascade to update definition
drop view if exists public.recent_expenses cascade;

-- 2. Recreate recent_expenses view with security_invoker = true to enforce RLS policies
create view public.recent_expenses
with (security_invoker = true) as
select 
    e.id,
    e.user_id,
    e.amount,
    e.description,
    e.expense_date,
    coalesce(e.payment_method, 'Cash') as payment_method,
    coalesce(e.is_upload, 'N') as is_upload,
    e.created_at,
    c.name as category_name,
    c.color as category_color,
    c.icon as category_icon
from public.expenses e
join public.categories c on e.category_id = c.id;

-- 3. Recreate RPC function depending on recent_expenses view
create or replace function public.get_recent_transactions(p_limit int default 10)
returns setof public.recent_expenses
language sql security invoker as $$
    select *
    from public.recent_expenses
    where user_id = auth.uid()
    order by expense_date desc, id desc
    limit p_limit;
$$;
