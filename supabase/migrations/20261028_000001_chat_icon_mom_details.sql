-- Migration: chat group icons, and the meeting details a MOM was missing.
-- Idempotent.
--
-- chat_groups.icon_url: the group picture, an uploaded project file served
-- from /apis/v3/files/file/{id}.
-- moms: a MOM had no title, no meeting date (the register filtered on the
-- day it was typed in), no venue and no action items.

ALTER TABLE "chat_groups" ADD COLUMN IF NOT EXISTS "icon_url" VARCHAR(1024);

ALTER TABLE "moms" ADD COLUMN IF NOT EXISTS "title" VARCHAR(255);
ALTER TABLE "moms" ADD COLUMN IF NOT EXISTS "meeting_date" DATE;
ALTER TABLE "moms" ADD COLUMN IF NOT EXISTS "venue" VARCHAR(255);
ALTER TABLE "moms" ADD COLUMN IF NOT EXISTS "action_items" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Existing minutes keep their date: the day they were recorded.
UPDATE "moms" SET "meeting_date" = ("created_at" AT TIME ZONE 'Asia/Kolkata')::date WHERE "meeting_date" IS NULL;
