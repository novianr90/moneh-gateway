-- 1. Extensions
create extension if not exists "uuid-ossp";

-- 2. Categories Table
create table if not exists public.categories (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null,
    icon text default 'tag',
    color text default '#6b7280',
    created_at timestamptz not null default now(),
    
    constraint categories_user_id_name_key unique (user_id, name)
);

comment on table public.categories is 'Master data categories created by users';

-- 3. Expenses Table
create table if not exists public.expenses (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    category_id uuid not null references public.categories(id) on delete restrict,
    amount bigint not null check (amount > 0),
    description text default '',
    expense_date date not null default current_date,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

comment on table public.expenses is 'Personal transaction logs stored in IDR (bigint)';

-- 4. Sync Logs Table
create table if not exists public.sync_logs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    status text not null check (status in ('in_progress', 'success', 'failed')),
    synced_count integer default 0,
    error_message text,
    created_at timestamptz not null default now()
);

comment on table public.sync_logs is 'Audit and execution log for Google Sheets sync (30-day retention)';

-- 5. Indexes
create index if not exists idx_categories_user on public.categories (user_id);
create index if not exists idx_expenses_user_date on public.expenses (user_id, expense_date desc);
create index if not exists idx_expenses_category on public.expenses (category_id);
create index if not exists idx_sync_logs_user_started on public.sync_logs (user_id, started_at desc);

-- 6. Triggers & Functions
create or replace function public.update_updated_at_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists set_expenses_updated_at on public.expenses;
create trigger set_expenses_updated_at
    before update on public.expenses
    for each row
    execute function public.update_updated_at_column();

-- Auto-provision default categories trigger
create or replace function public.handle_new_user_categories()
returns trigger as $$
begin
    insert into public.categories (user_id, name, icon, color) values
        (new.id, 'Food', 'utensils', '#ef4444'),
        (new.id, 'Coffee', 'coffee', '#8b5cf6'),
        (new.id, 'Transport', 'car', '#3b82f6'),
        (new.id, 'Bills', 'file-text', '#f59e0b'),
        (new.id, 'Entertainment', 'film', '#ec4899'),
        (new.id, 'Grocery', 'shopping-cart', '#10b981');
    return new;
exception
    when others then
        raise exception 'Failed to auto-provision user default categories: %', SQLERRM;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row
    execute function public.handle_new_user_categories();

-- 7. Views
drop view if exists public.recent_expenses cascade;
create view public.recent_expenses as
select 
    e.id,
    e.user_id,
    e.amount,
    e.description,
    e.expense_date,
    c.name as category_name,
    c.color as category_color,
    c.icon as category_icon
from public.expenses e
join public.categories c on e.category_id = c.id;

-- 8. RPC Functions
create or replace function public.get_monthly_summary(p_month date default current_date)
returns table (
    total_amount bigint,
    transaction_count bigint,
    prev_month_total bigint
) language plpgsql security invoker as $$
declare
    v_start_date date := date_trunc('month', p_month)::date;
    v_end_date date := (date_trunc('month', p_month) + interval '1 month')::date;
    v_prev_start date := (date_trunc('month', p_month) - interval '1 month')::date;
begin
    return query
    select 
        coalesce(sum(case when expense_date >= v_start_date and expense_date < v_end_date then amount else 0 end), 0)::bigint as total_amount,
        count(case when expense_date >= v_start_date and expense_date < v_end_date then id else null end)::bigint as transaction_count,
        coalesce(sum(case when expense_date >= v_prev_start and expense_date < v_start_date then amount else 0 end), 0)::bigint as prev_month_total
    from public.expenses
    where user_id = auth.uid();
end;
$$;

create or replace function public.get_monthly_category_breakdown(p_month date default current_date)
returns table (
    category_id uuid,
    category_name text,
    color text,
    icon text,
    total_amount bigint
) language plpgsql security invoker as $$
begin
    return query
    select 
        c.id as category_id,
        c.name as category_name,
        c.color,
        c.icon,
        coalesce(sum(e.amount), 0)::bigint as total_amount
    from public.categories c
    left join public.expenses e 
        on c.id = e.category_id 
       and e.expense_date >= date_trunc('month', p_month)::date
       and e.expense_date < (date_trunc('month', p_month) + interval '1 month')::date
    where c.user_id = auth.uid()
    group by c.id, c.name, c.color, c.icon
    order by total_amount desc;
end;
$$;

create or replace function public.get_recent_transactions(p_limit int default 10)
returns setof public.recent_expenses
language sql security invoker as $$
    select *
    from public.recent_expenses
    where user_id = auth.uid()
    order by expense_date desc, id desc
    limit p_limit;
$$;

-- 9. Row Level Security (RLS)
alter table public.categories enable row level security;
alter table public.expenses enable row level security;
alter table public.sync_logs enable row level security;

drop policy if exists "Categories: select own" on public.categories;
drop policy if exists "Categories: insert own" on public.categories;
drop policy if exists "Categories: update own" on public.categories;
drop policy if exists "Categories: delete own" on public.categories;

create policy "Categories: select own" on public.categories for select using (auth.uid() = user_id);
create policy "Categories: insert own" on public.categories for insert with check (auth.uid() = user_id);
create policy "Categories: update own" on public.categories for update using (auth.uid() = user_id);
create policy "Categories: delete own" on public.categories for delete using (auth.uid() = user_id);

drop policy if exists "Expenses: select own" on public.expenses;
drop policy if exists "Expenses: insert own" on public.expenses;
drop policy if exists "Expenses: update own" on public.expenses;
drop policy if exists "Expenses: delete own" on public.expenses;

create policy "Expenses: select own" on public.expenses for select using (auth.uid() = user_id);
create policy "Expenses: insert own" on public.expenses for insert with check (auth.uid() = user_id);
create policy "Expenses: update own" on public.expenses for update using (auth.uid() = user_id);
create policy "Expenses: delete own" on public.expenses for delete using (auth.uid() = user_id);

drop policy if exists "SyncLogs: select own" on public.sync_logs;
drop policy if exists "SyncLogs: insert own" on public.sync_logs;

create policy "SyncLogs: select own" on public.sync_logs for select using (auth.uid() = user_id);
create policy "SyncLogs: insert own" on public.sync_logs for insert with check (auth.uid() = user_id);
