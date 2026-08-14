-- Create RPC function get_daily_expense_trends
create or replace function public.get_daily_expense_trends(p_month date default current_date)
returns table (
    expense_date date,
    daily_total bigint,
    cumulative_total bigint
) language plpgsql security invoker as $$
declare
    v_start_date date := date_trunc('month', p_month)::date;
    v_end_date date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
    return query
    with date_series as (
        select generate_series(
            v_start_date,
            case 
                when date_trunc('month', current_date) = v_start_date then current_date
                else (v_end_date - interval '1 day')::date
            end,
            interval '1 day'
        )::date as d_date
    ),
    daily_sum as (
        select 
            e.expense_date,
            sum(e.amount)::bigint as total
        from public.expenses e
        where e.user_id = auth.uid()
          and e.expense_date >= v_start_date
          and e.expense_date < v_end_date
        group by e.expense_date
    )
    select 
        ds.d_date as expense_date,
        coalesce(ds_sum.total, 0)::bigint as daily_total,
        sum(coalesce(ds_sum.total, 0)) over (order by ds.d_date)::bigint as cumulative_total
    from date_series ds
    left join daily_sum ds_sum on ds.d_date = ds_sum.expense_date
    order by ds.d_date;
end;
$$;

comment on function public.get_daily_expense_trends(date) is 'Returns daily totals and running cumulative spending for a given month';
