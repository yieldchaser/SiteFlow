-- Migration: how each employee's salary is paid. Idempotent.
--
-- staff_employees.salary_paid_by: 'bank' (default) or 'cash'.
-- bank_account / bank_ifsc: where a bank-paid salary goes. Empty for cash.

ALTER TABLE "staff_employees" ADD COLUMN IF NOT EXISTS "salary_paid_by" VARCHAR(20) NOT NULL DEFAULT 'bank';
ALTER TABLE "staff_employees" ADD COLUMN IF NOT EXISTS "bank_account" VARCHAR(30);
ALTER TABLE "staff_employees" ADD COLUMN IF NOT EXISTS "bank_ifsc" VARCHAR(11);
