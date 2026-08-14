-- 1. Enable pg_cron extension if available
create extension if not exists pg_cron with schema extensions;

-- 2. RPC Function to safely query all cron.job entries for the UI status badge
create or replace function public.get_cron_jobs()
returns table (
    jobid bigint,
    schedule text,
    command text,
    active boolean,
    jobname text
)
language plpgsql security definer as $$
begin
    -- Check if cron.job table exists before querying
    if exists (
        select 1 
        from information_schema.tables 
        where table_schema = 'cron' and table_name = 'job'
    ) then
        return query execute 'select jobid, schedule, command, active, jobname from cron.job';
    else
        -- Return empty result if pg_cron is not enabled
        return;
    end if;
end;
$$;

-- Grant execution permission to authenticated users
grant execute on function public.get_cron_jobs() to authenticated;
