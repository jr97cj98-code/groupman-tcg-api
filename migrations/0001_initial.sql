PRAGMA foreign_keys = ON;

CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    owner_member_id TEXT NOT NULL,
    invite_hash TEXT NOT NULL,
    invite_expires_at INTEGER NOT NULL,
    collection_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE members (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    rsn_key TEXT NOT NULL,
    rsn_display TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    approved_at INTEGER,
    revoked_at INTEGER,
    last_seen_at INTEGER NOT NULL,
    UNIQUE (group_id, rsn_key)
);

CREATE TABLE pack_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id),
    opened_at INTEGER NOT NULL,
    cards_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE group_unlocks (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    card_name_key TEXT NOT NULL,
    card_name TEXT NOT NULL,
    first_member_id TEXT REFERENCES members(id),
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, card_name_key)
);

CREATE INDEX idx_members_group_status
    ON members(group_id, status, revoked_at);

CREATE INDEX idx_pack_events_group_seq
    ON pack_events(group_id, seq);

CREATE INDEX idx_group_unlocks_group_name
    ON group_unlocks(group_id, card_name);

