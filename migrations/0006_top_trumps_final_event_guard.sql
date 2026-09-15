CREATE UNIQUE INDEX idx_top_trumps_one_final_event
    ON top_trumps_events(challenge_id)
    WHERE event_type IN ('declined', 'result');
