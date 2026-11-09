-- Tasks made from the planning screen were saved as 'pending' and progress
-- updates set 'ongoing'. The daily report only moves 'not_started' tasks on and
-- reports count 'in_progress' as active, so bring old rows onto one set.
UPDATE tasks SET status = 'not_started' WHERE status IS NULL OR status IN ('pending', '');
UPDATE tasks SET status = 'in_progress' WHERE status = 'ongoing';

-- Milestones are upcoming or achieved; a missed date is shown as delayed by
-- the screen itself.
UPDATE project_milestones SET status = 'upcoming' WHERE status IS NULL OR status NOT IN ('upcoming', 'achieved');
