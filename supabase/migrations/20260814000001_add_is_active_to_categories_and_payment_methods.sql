-- Migration: Add is_active flag to categories and payment_methods for non-destructive soft deactivation

-- 1. Add is_active column to public.categories
ALTER TABLE public.categories 
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- 2. Add is_active column to public.payment_methods
ALTER TABLE public.payment_methods 
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- 3. Add Indexes for active queries
CREATE INDEX IF NOT EXISTS idx_categories_user_active ON public.categories (user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_payment_methods_user_active ON public.payment_methods (user_id, is_active);
