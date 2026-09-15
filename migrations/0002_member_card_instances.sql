CREATE TABLE member_card_instances (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    source_instance_id TEXT NOT NULL,
    card_name_key TEXT NOT NULL,
    card_name TEXT NOT NULL,
    foil INTEGER NOT NULL CHECK (foil IN (0, 1)),
    pulled_by TEXT NOT NULL,
    pulled_at INTEGER NOT NULL,
    acquisition_kind TEXT NOT NULL CHECK (acquisition_kind IN ('pack_or_trade', 'debug', 'unknown')),
    snapshot_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, member_id, source_instance_id)
);

CREATE INDEX idx_member_card_instances_member_card
    ON member_card_instances(group_id, member_id, card_name_key);

CREATE INDEX idx_member_card_instances_group_card
    ON member_card_instances(group_id, card_name_key);

