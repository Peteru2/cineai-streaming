import type { Pool } from 'pg';
import type { VideoStore } from '../domain/transition.js';
import { assertTransition, type VideoStatus } from '../domain/status.js';

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
export interface VideoRecord {
  id: string;
  creatorId: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  status: VideoStatus;
  uploadId: string | null;
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
  upload_id: string | null;
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
    uploadId: row.upload_id,
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

  /** Sets the storage upload ID only if none is set yet. Returns true if this call set it. */
  async setUploadIdIfEmpty(id: string, uploadId: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE videos SET upload_id = $2, updated_at = now()
       WHERE id = $1 AND upload_id IS NULL`,
      [id, uploadId],
    );
    return res.rowCount === 1;
  }

    /** Newest finished videos first. Only ready videos are ever returned. */
  async listReady(limit: number): Promise<VideoRecord[]> {
    const res = await this.pool.query<VideoRow>(
      `SELECT * FROM videos WHERE status = 'ready' ORDER BY updated_at DESC, id LIMIT $1`,
      [limit],
    );
    return res.rows.map(toRecord);
  }

  async listByCreator(creatorId: string, status?: VideoStatus): Promise<VideoRecord[]> {
    const res = status
      ? await this.pool.query<VideoRow>(
          `SELECT * FROM videos WHERE creator_id = $1 AND status = $2 ORDER BY created_at DESC`,
          [creatorId, status],
        )
      : await this.pool.query<VideoRow>(
          `SELECT * FROM videos WHERE creator_id = $1 ORDER BY created_at DESC`,
          [creatorId],
        );
    return res.rows.map(toRecord);
  }


    /**
   * A worker claims a queued video. Increments attempts, which doubles as
   * the lease token for every later heartbeat and completion.
   */
  async claimForProcessing(id: string): Promise<VideoRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<VideoRow>(
        `UPDATE videos
         SET status = 'processing', attempts = attempts + 1,
             heartbeat_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'queued'
         RETURNING *`,
        [id],
      );
      if (res.rowCount !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `INSERT INTO video_events (video_id, from_status, to_status) VALUES ($1, 'queued', 'processing')`,
        [id],
      );
      await client.query('COMMIT');
      return toRecord(res.rows[0] as VideoRow);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** "I'm still alive." Returns false if this attempt no longer owns the video. */
  async heartbeat(id: string, attempt: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE videos SET heartbeat_at = now()
       WHERE id = $1 AND status = 'processing' AND attempts = $2`,
      [id, attempt],
    );
    return res.rowCount === 1;
  }

  /** Ends an attempt. Only the attempt that owns the video can do this. */
  async completeProcessing(
    id: string,
    attempt: number,
    to: 'ready' | 'failed' | 'queued',
    reason?: string,
  ): Promise<boolean> {
    assertTransition('processing', to);
    const failureReason = to === 'failed' ? (reason ?? 'unknown error') : null;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `UPDATE videos
         SET status = $3, heartbeat_at = NULL, failure_reason = $4, updated_at = now()
         WHERE id = $1 AND status = 'processing' AND attempts = $2`,
        [id, attempt, to, failureReason],
      );
      if (res.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO video_events (video_id, from_status, to_status, reason)
         VALUES ($1, 'processing', $2, $3)`,
        [id, to, reason ?? null],
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


    /** Videos whose worker has gone quiet. Uses the database clock, like the heartbeat. */
  async findStalledProcessing(
    staleSeconds: number,
    limit = 100,
  ): Promise<{ id: string; attempts: number }[]> {
    const res = await this.pool.query<{ id: string; attempts: number }>(
      `SELECT id, attempts FROM videos
       WHERE status = 'processing'
         AND COALESCE(heartbeat_at, updated_at) < now() - make_interval(secs => $1)
       ORDER BY COALESCE(heartbeat_at, updated_at)
       LIMIT $2`,
      [staleSeconds, limit],
    );
    return res.rows;
  }

  /** Videos that have sat in one status for too long. */
  async findStale(status: VideoStatus, staleSeconds: number, limit = 100): Promise<VideoRecord[]> {
    const res = await this.pool.query<VideoRow>(
      `SELECT * FROM videos
       WHERE status = $1 AND updated_at < now() - make_interval(secs => $2)
       ORDER BY updated_at
       LIMIT $3`,
      [status, staleSeconds, limit],
    );
    return res.rows.map(toRecord);
  }

  /**
   * Takes a video away from a worker that has gone quiet. The same WHERE clause
   * re-checks, at the moment of the update, that THIS attempt still owns the
   * video and its heartbeat is STILL stale. A heartbeat that sneaks in first wins.
   */
  async expireStalled(
    id: string,
    attempt: number,
    staleSeconds: number,
    to: 'queued' | 'failed',
    reason: string,
  ): Promise<boolean> {
    assertTransition('processing', to);
    const failureReason = to === 'failed' ? reason : null;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `UPDATE videos
         SET status = $3, heartbeat_at = NULL, failure_reason = $4, updated_at = now()
         WHERE id = $1 AND status = 'processing' AND attempts = $2
           AND COALESCE(heartbeat_at, updated_at) < now() - make_interval(secs => $5)`,
        [id, attempt, to, failureReason, staleSeconds],
      );
      if (res.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO video_events (video_id, from_status, to_status, reason)
         VALUES ($1, 'processing', $2, $3)`,
        [id, to, reason],
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

