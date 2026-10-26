-- Migration: limit a team member to chosen projects. Idempotent.
--
-- company_team.project_scope: 'all' (default, every project in the company,
-- the behaviour before this column existed) or 'assigned' (only the projects
-- linked to the member in project_members). Owners and full-access roles always
-- see every project whatever this says.

ALTER TABLE "company_team" ADD COLUMN IF NOT EXISTS "project_scope" VARCHAR(20) NOT NULL DEFAULT 'all';
