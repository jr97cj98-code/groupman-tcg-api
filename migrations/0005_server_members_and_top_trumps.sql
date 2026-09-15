ALTER TABLE members ADD COLUMN player_name TEXT;
ALTER TABLE members ADD COLUMN player_name_key TEXT;
ALTER TABLE members ADD COLUMN collection_mode TEXT NOT NULL DEFAULT 'shared'
    CHECK (collection_mode IN ('shared', 'solo'));

CREATE INDEX idx_members_group_player_name
    ON members(group_id, player_name_key, revoked_at);

CREATE TABLE top_trumps_challenges (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    challenger_member_id TEXT NOT NULL REFERENCES members(id),
    challenged_member_id TEXT NOT NULL REFERENCES members(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    responded_at INTEGER
);

CREATE INDEX idx_top_trumps_challenges_participants
    ON top_trumps_challenges(group_id, challenger_member_id, challenged_member_id, status);

CREATE TABLE top_trumps_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    challenge_id TEXT NOT NULL REFERENCES top_trumps_challenges(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('challenge', 'declined', 'result')),
    challenger_member_id TEXT NOT NULL REFERENCES members(id),
    challenged_member_id TEXT NOT NULL REFERENCES members(id),
    challenger_card TEXT,
    challenged_card TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_top_trumps_events_group_seq
    ON top_trumps_events(group_id, seq);
