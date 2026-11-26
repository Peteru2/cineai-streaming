# CineAI

A streaming platform for generative filmmakers. Creators upload large video files over unreliable networks, and viewers watch on anything from fibre to weak mobile data.

This project answers one failure: on premiere night, uploads froze at 85%, API servers fell over, films were stuck in "processing", viewers downloaded raw 2 GB files, audio drifted out of sync, and the cloud bill spiked. Every one of those came from the same mistake, treating video like a small web request. The design fixes each cause directly.

- **Design document:** [docs/DESIGN.md](docs/DESIGN.md) (architecture, data flows, failure modes, what is verified, known limits)
- **Trade-offs write-up:** see the repository for `docs/TRADEOFFS.md` once added

## How it works

```
Creator ──(1) create video──▶ API ──signed URLs──▶ Creator
Creator ──(2) 10 MB chunks, straight to storage────▶ Object storage
Creator ──(3) complete──▶ API ──▶ queue ──▶ Worker (FFmpeg) ──▶ HLS renditions in storage
Viewer  ◀── HLS playlist and segments (quality adapts to the network)
Watchdog: recovers silent jobs, lost completions and abandoned uploads
```

| Problem on premiere night | What the code does |
|---|---|
| Upload froze at 85% and restarted | Chunked multipart upload. After a drop, the app asks storage which parts exist and sends only the missing ones |
| 504s from the API | The API never touches video bytes. It issues signed URLs and keeps records. Chunks go straight to storage |
| Videos stuck in "processing" | Job queue, workers with a heartbeat, a watchdog that re-queues silent jobs, and a 3-attempt limit. Every video ends as `ready`, `failed` (with a reason) or `abandoned` |
| 2 GB downloads and buffering on mobile | Transcoding into a quality ladder (up to 1080p, never upscaled) and HLS streaming in 4-second segments |
| Audio out of sync | Constant frame rate, rebuilt audio timestamps and keyframes aligned across renditions |
| Billing spike | Probe before transcoding, retry limits, job timeout, size and type limits, a kill switch for new uploads, and no raw files served to viewers |

Duplicate signals (a creator clicking "complete" five times) are harmless: the status change is one atomic database step, so only the first request creates a job.

## What you need

- **Node.js 20.6 or newer** (developed on Node 24)
- **Docker Desktop** (or Docker Engine with the Compose plugin)
- **FFmpeg and ffprobe** on your PATH. Check with `ffmpeg -version`.
  - Windows: `winget install Gyan.FFmpeg`, then open a new terminal
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt-get install ffmpeg`

## Run it

Open four terminals from the repository root.

**1. Start Postgres, Redis and storage**

```
docker compose up -d
docker compose ps
```

All three services should be running. Postgres is on host port **5433**, Redis on 6379, and storage (RustFS, S3-compatible) on 9000 with a console on 9001.

**2. Set up the backend**

```
cd backend
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
npm run dev
```

You should see `Storage is open to browsers from: ...` and `API listening on port 3000`. Migrations run automatically.

**3. Start the worker** (a second terminal)

```
cd backend
npm run worker
```

**4. Start the frontend** (a third terminal)

```
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** (or `http://127.0.0.1:5173`). Those are the two origins storage is configured to allow.

**5. Optional: start the watchdog** (a fourth terminal)

```
cd backend
npm run watchdog
```

Pick a short MP4, upload it, and watch it move through Upload, Queued, Processing and Ready. It then appears on the home page.

## Try the failure cases

These are the three situations the project exists for.

1. **Weak mobile network.** Open DevTools, then Network, and set throttling to Slow 4G. Play a film and watch "Now playing" drop to a lower quality instead of buffering.
2. **Dropped connection.** Upload a file of 50 MB or more. Set DevTools Network to Offline mid-upload, then back to No throttling. The upload continues from where it stopped. You can also click Cancel at about 50%, select the same file again, and see the "Resuming" notice.
3. **Dead worker.** Start the watchdog, upload a video, and stop the worker (Ctrl+C) while the status says Processing. Within a few minutes the video returns to Queued. Restart the worker and it finishes.

## Tests

Docker services must be running, and FFmpeg must be installed (the FFmpeg tests skip themselves if it is missing).

```
cd backend
npm run typecheck
npm test

cd ../frontend
npm run typecheck
npm test
npm run build
```

The backend tests use real Postgres, Redis, storage and FFmpeg, not mocks, for the parts where behaviour matters: atomic status changes under simultaneous requests, resumable multipart upload, the watchdog, the worker's lease tokens, and one end-to-end test that pushes a real video from upload to ready. Tests always use the local Docker database, even if your `.env` points elsewhere.

## API

| Method and path | Purpose |
|---|---|
| `GET /health` | Liveness check (does not check the database) |
| `POST /videos` | Start an upload. Headers: `x-creator-id`, `idempotency-key`. Returns signed URLs for each part |
| `GET /videos?status=uploading` | The creator's own videos, optionally filtered |
| `GET /videos/:id` | Status of one video |
| `GET /videos/:id/parts` | Resume: which parts storage has, and fresh signed URLs for the rest |
| `POST /videos/:id/complete` | Finish the upload. Safe to call repeatedly |
| `GET /watch` | Newest ready films, for the home page |
| `GET /watch/:id` | Playlist and poster URLs, or `409` while the video is not ready |

## Configuration

Everything has a working local default. Override with environment variables (see `backend/.env.example`).

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | local Docker Postgres | Postgres connection |
| `UPLOADS_ENABLED` | `true` | Set to `false` to pause new uploads while playback keeps working (the cost kill switch) |
| `PART_SIZE_MB` / `MAX_FILE_SIZE_GB` | `10` / `5` | Chunk size and per-file limit |
| `WORKER_MAX_ATTEMPTS` | `3` | Attempts before a video is marked `failed` |
| `WORKER_HEARTBEAT_MS` | `30000` | How often a worker says it is alive |
| `WATCHDOG_STALL_SECONDS` | `120` | Silence before a worker is presumed dead |
| `WATCHDOG_ABANDON_AFTER_SECONDS` | `86400` | When an unfinished upload is abandoned |
| `JOB_TIMEOUT_MINUTES` | `30` | Hard limit on one processing job |
| `MAX_DURATION_MINUTES` | `60` | Longest accepted video |
| `MEDIA_BASE_URL` | local storage | Where players fetch playlists and segments (a CDN in production) |

## Repository layout

```
docs/DESIGN.md        Architecture, data flows, failure modes, verification, limits
backend/              API, worker, watchdog, migrations, tests (Node.js + TypeScript)
frontend/             Home, upload and viewer pages (React + TypeScript + hls.js)
docker-compose.yml    Postgres, Redis, S3-compatible storage for local development
```

## Decisions, briefly

- **Hybrid build.** The orchestration (upload flow, state machine, queue, workers, watchdog) is custom, because that is where the failures were. Underneath are standard, replaceable parts: Postgres, Redis, FFmpeg and any S3-compatible storage. At scale, the transcoding workers are the first thing to hand to a managed service.
- **Postgres is the source of truth.** The queue is only a wake-up call. A duplicate or stale ticket does nothing, because the worker must win an atomic claim first.
- **The attempt number is a lease token.** A worker that the watchdog replaced cannot overwrite the new worker's result.
- **Storage is behind a small interface.** When the originally chosen storage server's images disappeared mid-project, switching was a configuration change.

## Known limits

The full list is in section 17 of the design document. The ones that matter most:

- **No real authentication.** Identity is a creator ID header the browser supplies. This is the first thing to replace.
- **No private or scheduled films.** Any ready film is public and shows on the home page immediately.
- **Not load-tested.** "The API stays responsive" follows from the design and the simultaneous-request tests, but it has not been measured at 12,000 viewers.
- **Verified on synthetic video only.** The constant-frame-rate fix is proven on a generated 25 fps clip, not on real creator files.
- **No CDN.** Playback is served from storage. A CDN is documented, not deployed.
- **Cost controls are partly unbuilt:** rate limits, per-creator quotas, cold storage for masters, budget alerts and notifications.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ECONNREFUSED 127.0.0.1:5433` or `:9000` | Docker is not running, or the services are down. Run `docker compose up -d` |
| `password authentication failed for user "cineai"` | Another Postgres is listening on the port. This project uses host port 5433 to avoid that |
| Worker says FFmpeg is not found | Install FFmpeg and open a new terminal so it sees your PATH |
| Upload works but the video stays Queued | The worker is not running, or it uses a different `DATABASE_URL` than the API |
| Upload fails straight away in the browser | The page was opened at an address other than `localhost:5173` or `127.0.0.1:5173` |
| `getaddrinfo ENOTFOUND` for the database | `DATABASE_URL` is malformed. Make sure `backend/.env` has a single, clean line |

## Security note

The credentials in `docker-compose.yml` (`cineai` for Postgres, `rustfsadmin` for storage) are for local development only. Never commit a real database URL: `.env` files are ignored by git, and only `.env.example` is tracked.
