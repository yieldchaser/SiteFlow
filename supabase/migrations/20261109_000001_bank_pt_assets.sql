-- Migration: bank name on staff, and professional tax. Idempotent.
--
-- staff_employees.bank_name: the employee's bank, shown next to account/IFSC.
-- staff_employees.pt_applicable: false for staff exempt from professional tax.
-- companies.pt_state: the state whose PT slabs payroll uses. NULL = no PT.
-- payroll_line_items.professional_tax: PT deducted on that payslip.

ALTER TABLE "staff_employees" ADD COLUMN IF NOT EXISTS "bank_name" VARCHAR(100);
ALTER TABLE "staff_employees" ADD COLUMN IF NOT EXISTS "pt_applicable" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "pt_state" VARCHAR(50);
ALTER TABLE "payroll_line_items" ADD COLUMN IF NOT EXISTS "professional_tax" NUMERIC(14,2) NOT NULL DEFAULT 0;

-- equipment.serial_number / assigned_to: company assets such as laptops and
-- phones, who holds each one and its serial number.
ALTER TABLE "equipment" ADD COLUMN IF NOT EXISTS "serial_number" VARCHAR(100);
ALTER TABLE "equipment" ADD COLUMN IF NOT EXISTS "assigned_to" VARCHAR(255);
