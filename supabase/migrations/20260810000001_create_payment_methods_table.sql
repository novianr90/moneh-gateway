-- 1. Create Payment Methods Table
create table if not exists public.payment_methods (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null,
    created_at timestamptz not null default now(),
    
    constraint payment_methods_user_id_name_key unique (user_id, name)
);

comment on table public.payment_methods is 'Master data payment methods / wallets created by users';

-- 2. Indexes
create index if not exists idx_payment_methods_user on public.payment_methods (user_id);

-- 3. Auto-provision default payment methods function & trigger for new users
create or replace function public.handle_new_user_payment_methods()
returns trigger as $$
begin
    insert into public.payment_methods (user_id, name) values
        (new.id, 'Cash'),
        (new.id, 'QRIS'),
        (new.id, 'Credit Card'),
        (new.id, 'GoPay/OVO'),
        (new.id, 'Bank Transfer')
    on conflict (user_id, name) do nothing;
    return new;
exception
    when others then
        raise exception 'Failed to auto-provision user default payment methods: %', SQLERRM;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created_payment_methods on auth.users;
create trigger on_auth_user_created_payment_methods
    after insert on auth.users
    for each row
    execute function public.handle_new_user_payment_methods();

-- 4. Seed default payment methods for existing users
do $$
declare
    r record;
begin
    for r in select id from auth.users loop
        insert into public.payment_methods (user_id, name) values
            (r.id, 'Cash'),
            (r.id, 'QRIS'),
            (r.id, 'Credit Card'),
            (r.id, 'GoPay/OVO'),
            (r.id, 'Bank Transfer')
        on conflict (user_id, name) do nothing;
    end loop;
end $$;

-- 5. Row Level Security (RLS)
alter table public.payment_methods enable row level security;

drop policy if exists "PaymentMethods: select own" on public.payment_methods;
drop policy if exists "PaymentMethods: insert own" on public.payment_methods;
drop policy if exists "PaymentMethods: update own" on public.payment_methods;
drop policy if exists "PaymentMethods: delete own" on public.payment_methods;

create policy "PaymentMethods: select own" on public.payment_methods for select using (auth.uid() = user_id);
create policy "PaymentMethods: insert own" on public.payment_methods for insert with check (auth.uid() = user_id);
create policy "PaymentMethods: update own" on public.payment_methods for update using (auth.uid() = user_id);
create policy "PaymentMethods: delete own" on public.payment_methods for delete using (auth.uid() = user_id);
