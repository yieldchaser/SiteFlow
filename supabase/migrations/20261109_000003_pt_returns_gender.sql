-- Migration: professional tax in statutory returns; employee gender. Idempotent.
--
-- statutory_reports.professional_tax: PT deducted in the return period.
-- staff_employees.gender: male / female / other. Maharashtra PT exempts women
--   earning up to Rs 25,000 a month.

ALTER TABLE "statutory_reports" ADD COLUMN IF NOT EXISTS "professional_tax" NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "staff_employees" ADD COLUMN IF NOT EXISTS "gender" VARCHAR(10);
