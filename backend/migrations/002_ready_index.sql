-- Keeps the home page fast: it only ever asks for the newest ready videos.
CREATE INDEX IF NOT EXISTS videos_ready_idx ON videos (updated_at DESC) WHERE status = 'ready';