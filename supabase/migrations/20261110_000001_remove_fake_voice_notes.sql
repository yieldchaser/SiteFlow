-- The task panel's voice-note button saved a made-up address and no audio.
-- Drop the address; where the comment only said "Voice note logged", say
-- plainly that nothing was recorded. Typed text is kept as it is.
UPDATE task_comments
SET message_text = CASE
        WHEN message_text = 'Voice note logged'
            THEN 'Voice note not saved (the old button did not record audio)'
        ELSE message_text
    END,
    voice_note_url = NULL
WHERE voice_note_url LIKE '%siteflow-voice-records%';
