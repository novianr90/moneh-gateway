-- RPC Function to safely query all cron.job entries for the UI status badge
create or replace function public.get_cron_jobs()
returns table (
    jobid bigint,
    schedule text,
    command text,
    active boolean,
    jobname text
)
language sql security definer as $$
    select jobid, schedule, command, active, jobname
    from cron.job;
$$;

-- Grant execution permission to authenticated users
grant execute on function public.get_cron_jobs() to authenticated;
