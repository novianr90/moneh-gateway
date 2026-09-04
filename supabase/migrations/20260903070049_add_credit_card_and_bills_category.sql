-- ISSUES #7 [FEAT] Auto-Adjust Bills on Next-Month if Transactions is using Account as Credit Card

-- 1. Flag a payment method as Credit Card / paylater (single flag covers both semantics).
--    Supabase-only concept -- not synced to/from Actual Budget's account model.
ALTER TABLE public.payment_methods
    ADD COLUMN IF NOT EXISTS is_credit_card BOOLEAN NOT NULL DEFAULT false;

-- 2. Let each user pick which of their categories represents "Bills" (dashboard-driven,
--    not hardcoded). Nullable: a user may not have configured it yet.
ALTER TABLE public.users_configurations
    ADD COLUMN IF NOT EXISTS bills_category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL;
