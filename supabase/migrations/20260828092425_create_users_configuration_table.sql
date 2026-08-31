-- ISSUES #2 [FEAT] Multiple Users use Multiple Budget
CREATE TABLE IF NOT EXISTS public.users_configurations(
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade unique,
    -- Nullable: a user may not have configured their Actual Budget sync id yet.
    -- Blank/empty state is treated by the Gateway as "Actual Budget not configured".
    actual_sync_id text unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

COMMENT ON TABLE public.users_configurations IS 'Master data users configurations key';

ALTER TABLE public.users_configurations enable ROW LEVEL SECURITY;

CREATE POLICY "Users can view own configuration"
ON public.users_configurations
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own configuration"
ON public.users_configurations
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own configuration"
ON public.users_configurations
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.set_users_configurations_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_configurations_updated_at
BEFORE UPDATE ON public.users_configurations
FOR EACH ROW
EXECUTE FUNCTION public.set_users_configurations_updated_at();
