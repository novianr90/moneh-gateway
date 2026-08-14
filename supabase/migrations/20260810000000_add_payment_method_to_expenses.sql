-- 1. Drop view cascade FIRST so column type can be altered or view replaced
drop view if exists public.recent_expenses cascade;

-- 2. Add payment_method column to public.expenses if it doesn't exist
do $$ 
begin
    if not exists (
        select 1 
        from information_schema.columns 
        where table_schema = 'public' 
          and table_name = 'expenses' 
          and column_name = 'payment_method'
    ) then
        alter table public.expenses add column payment_method text default 'Cash';
    end if;
end $$;

-- 3. Ensure no null values exist for payment_method
update public.expenses set payment_method = 'Cash' where payment_method is null;

-- 4. Recreate recent_expenses view with payment_method included
create view public.recent_expenses as
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

-- 5. Recreate RPC function depending on recent_expenses view
create or replace function public.get_recent_transactions(p_limit int default 10)
returns setof public.recent_expenses
language sql security invoker as $$
    select *
    from public.recent_expenses
    where user_id = auth.uid()
    order by expense_date desc, id desc
    limit p_limit;
$$;
