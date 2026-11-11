-- Head office is a cost centre, not a site. Projects get a real switch for it,
-- set here for the office projects companies already made (by name or category),
-- so renaming the head office later no longer stops it being treated as one.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_head_office boolean NOT NULL DEFAULT false;

UPDATE projects
SET is_head_office = true
WHERE is_head_office = false
  AND (
    trim(coalesce(category, '')) = 'Head Office / Office'
    OR lower(name) ~ '(head|corporate|registered|regional) office'
    OR lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))) IN ('ho', 'office', 'hq')
  );
