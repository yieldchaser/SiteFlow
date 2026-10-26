-- Migration: biometric attendance terminals (ADMS push)
-- Idempotent.
--
-- biometric_devices: site terminals registered by serial number; the /iclock
-- push endpoint accepts only these.
-- biometric_punches: every punch a terminal sent, kept even when its device
-- user ID is not mapped to an employee yet.
-- staff_employees.biometric_pin: the employee's user ID on the terminal.

ALTER TABLE "staff_employees" ADD COLUMN IF NOT EXISTS "biometric_pin" VARCHAR(20);

CREATE TABLE IF NOT EXISTS "biometric_devices" (
    "id" UUID PRIMARY KEY,
    "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
    "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
    "serial_number" VARCHAR(64) NOT NULL UNIQUE,
    "name" VARCHAR(255) NOT NULL,
    "tz_offset_minutes" INTEGER NOT NULL DEFAULT 330,
    "last_seen_at" TIMESTAMP WITH TIME ZONE,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "biometric_punches" (
    "id" UUID PRIMARY KEY,
    "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
    "device_id" UUID NOT NULL REFERENCES "biometric_devices"("id") ON DELETE CASCADE,
    "device_pin" VARCHAR(20) NOT NULL,
    "punch_time" TIMESTAMP WITH TIME ZONE NOT NULL,
    "verify_mode" VARCHAR(20),
    "employee_id" UUID REFERENCES "staff_employees"("id") ON DELETE SET NULL,
    "attendance_log_id" UUID REFERENCES "attendance_logs"("id") ON DELETE SET NULL,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT "uq_biometric_punches_device_pin_time" UNIQUE ("device_id", "device_pin", "punch_time")
);

CREATE INDEX IF NOT EXISTS "ix_biometric_punches_company_time" ON "biometric_punches" ("company_id", "punch_time");

ALTER TABLE IF EXISTS "biometric_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "biometric_devices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "biometric_devices_tenant_scoped" ON "biometric_devices";
CREATE POLICY "biometric_devices_tenant_scoped" ON "biometric_devices"
  FOR ALL TO authenticated
  USING (company_id IN (SELECT ct.company_id FROM company_team ct WHERE ct.user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT ct.company_id FROM company_team ct WHERE ct.user_id = auth.uid()));

ALTER TABLE IF EXISTS "biometric_punches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "biometric_punches" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "biometric_punches_tenant_scoped" ON "biometric_punches";
CREATE POLICY "biometric_punches_tenant_scoped" ON "biometric_punches"
  FOR ALL TO authenticated
  USING (company_id IN (SELECT ct.company_id FROM company_team ct WHERE ct.user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT ct.company_id FROM company_team ct WHERE ct.user_id = auth.uid()));
