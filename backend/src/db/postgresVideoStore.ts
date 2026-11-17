import type { Pool } from 'pg';
import type { VideoStore } from '../domain/transition.js';
import type { VideoStatus } from '../domain/status.js';

export interface NewVideo {
  creatorId: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  idempotencyKey: string;
}

export interface VideoRecord {
  id: string;
  creatorId: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  status: VideoStatus;
  attempts: number;
  failureReason: string | null;
  createdAt: Date;
}

interface VideoRow {
  id: string;
  creator_id: string;
  filename: string;
  size_bytes: string; // Postgres returns bigint as text
  content_type: string;
  status: VideoStatus;
  attempts: number;
  failure_reason: string | null;
  created_at: Date;
}

function toRecord(row: VideoRow): VideoRecord {
  return {
    id: row.id,
    creatorId: row.creator_id,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    contentType: row.content_type,
    status: row.status,
    attempts: row.attempts,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

export class PostgresVideoStore implements VideoStore {
  constructor(private readonly pool: Pool) {}

  /** Idempotent: the same (creator, key) always returns the same video. */
  async createVideo(input: NewVideo): Promise<{ video: VideoRecord; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query<VideoRow>(
        `INSERT INTO videos (creator_id, filename, size_bytes, content_type, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (creator_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [input.creatorId, input.filename, input.sizeBytes, input.contentType, input.idempotencyKey],
      );

      if (inserted.rows.length === 1) {
        const row = inserted.rows[0] as VideoRow;
        await client.query(
          `INSERT INTO video_events (video_id, from_status, to_status) VALUES ($1, NULL, 'uploading')`,
          [row.id],
        );
        await client.query('COMMIT');
        return { video: toRecord(row), created: true };
      }

      const existing = await client.query<VideoRow>(
        `SELECT * FROM videos WHERE creator_id = $1 AND idempotency_key = $2`,
        [input.creatorId, input.idempotencyKey],
      );
      await client.query('COMMIT');
      return { video: toRecord(existing.rows[0] as VideoRow), created: false };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getVideo(id: string): Promise<VideoRecord | null> {
    const res = await this.pool.query<VideoRow>(`SELECT * FROM videos WHERE id = $1`, [id]);
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  /**
   * One SQL statement does the check and the change together. The event row
   * is written in the same transaction, so status and history cannot disagree.
   */
  async compareAndSetStatus(
    id: string,
    from: VideoStatus,
    to: VideoStatus,
    reason?: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query(
        `UPDATE videos SET status = $3, updated_at = now()
         WHERE id = $1 AND status = $2`,
        [id, from, to],
      );

      if (res.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `INSERT INTO video_events (video_id, from_status, to_status, reason)
         VALUES ($1, $2, $3, $4)`,
        [id, from, to, reason ?? null],
      );

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}