-- The v2 API never uses these legacy fields. Migration 0003 redacted their
-- contents; this migration removes the identity-shaped schema entirely.
ALTER TABLE members RENAME COLUMN rsn_key TO member_key;
ALTER TABLE members DROP COLUMN rsn_display;
ALTER TABLE member_card_instances DROP COLUMN pulled_by;
