ALTER TABLE members ADD COLUMN member_label TEXT;

UPDATE members
SET member_label = CASE
    WHEN role = 'owner' THEN 'Owner'
    ELSE 'Member ' || UPPER(SUBSTR(REPLACE(id, '-', ''), -6))
END;

-- Remove legacy RuneScape names and original-puller labels from existing data.
-- The legacy columns remain only for schema compatibility and contain opaque values.
UPDATE members
SET rsn_key = 'private_' || id,
    rsn_display = 'Private member';

UPDATE member_card_instances
SET pulled_by = '';

CREATE TABLE instance_registration (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    group_id TEXT NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO instance_registration (slot, group_id)
SELECT 1, id FROM groups ORDER BY created_at LIMIT 1;
