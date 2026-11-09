-- Migration: weekly off per employee, holidays per site. Idempotent.
--
-- staff_employees.weekly_off_days: this person's weekly off days, e.g.
--   ["Sunday"]. NULL = use the company's weekly off.
-- holidays.project_id: NULL = holiday at every site; set = only that site.

ALTER TABLE "staff_employees" ADD COLUMN IF NOT EXISTS "weekly_off_days" JSONB;
ALTER TABLE "holidays" ADD COLUMN IF NOT EXISTS "project_id" UUID REFERENCES "projects"("id") ON DELETE CASCADE;
