CREATE TABLE IF NOT EXISTS videos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id      text NOT NULL,
  filename        text NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
  content_type    text NOT NULL,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading','uploaded','queued','processing','ready','failed','abandoned')),
  upload_id       text,
  attempts        integer NOT NULL DEFAULT 0,
  heartbeat_at    timestamptz,
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS videos_status_idx ON videos (status);

CREATE TABLE IF NOT EXISTS video_events (
  id          bigserial PRIMARY KEY,
  video_id    uuid NOT NULL REFERENCES videos(id),
  from_status text,
  to_status   text NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_events_video_idx ON video_events (video_id, id);