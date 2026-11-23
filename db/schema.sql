CREATE TABLE IF NOT EXISTS pastes (
    id text PRIMARY KEY,
    content text NOT NULL,
    expires_at timestamptz,
    remaining_views bigint CHECK (remaining_views >= 0)
);
