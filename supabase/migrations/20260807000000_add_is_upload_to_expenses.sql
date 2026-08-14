-- 1. Drop view cascade FIRST so column type can be altered
drop view if exists public.recent_expenses cascade;

-- 2. Safely convert or add is_upload column as text ('N' / 'Y')
do $$ 
begin
    if exists (
        select 1 
        from information_schema.columns 
        where table_schema = 'public' 
          and table_name = 'expenses' 
          and column_name = 'is_upload'
    ) then
        alter table public.expenses 
        alter column is_upload drop default,
        alter column is_upload type text using (
            case 
                when is_upload::text in ('true', 't', '1', 'Y') then 'Y'
                else 'N'
            end
        ),
        alter column is_upload set default 'N';
    else
        alter table public.expenses add column is_upload text default 'N';
    end if;
end $$;

-- 3. Ensure no null values exist
update public.expenses set is_upload = 'N' where is_upload is null;

-- 4. Create index for filtering un-uploaded transactions efficiently
create index if not exists idx_expenses_user_is_upload 
on public.expenses (user_id, is_upload);

-- 5. Recreate recent_expenses view with is_upload included
create view public.recent_expenses as
select 
    e.id,
    e.user_id,
    e.amount,
    e.description,
    e.expense_date,
    coalesce(e.is_upload, 'N') as is_upload,
    e.created_at,
    c.name as category_name,
    c.color as category_color,
    c.icon as category_icon
from public.expenses e
join public.categories c on e.category_id = c.id;

-- 6. Recreate RPC function depending on recent_expenses view
create or replace function public.get_recent_transactions(p_limit int default 10)
returns setof public.recent_expenses
language sql security invoker as $$
    select *
    from public.recent_expenses
    where user_id = auth.uid()
    order by expense_date desc, id desc
    limit p_limit;
$$;

-- 7. Add missing RLS UPDATE policy for sync_logs
drop policy if exists "SyncLogs: update own" on public.sync_logs;
create policy "SyncLogs: update own" on public.sync_logs for update using (auth.uid() = user_id);

