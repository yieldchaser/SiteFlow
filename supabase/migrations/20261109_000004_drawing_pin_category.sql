-- Migration: a drawing pin keeps its kind. Idempotent.
--
-- drawing_pins.category: RFI / Clash / Observation / Approval. The drawing
--   screen let you pick one and filter by it, but the column did not exist,
--   so every pin came back as an Observation after a reload.

ALTER TABLE "drawing_pins" ADD COLUMN IF NOT EXISTS "category" VARCHAR(20) NOT NULL DEFAULT 'Observation';
