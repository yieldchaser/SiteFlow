-- A work order amendment now keeps what the changed fields were before it,
-- so the history reads "value 10,00,000 -> 12,50,000" and not just the new
-- number.
ALTER TABLE IF EXISTS "work_order_amendments"
  ADD COLUMN IF NOT EXISTS "previous_values" JSONB;
