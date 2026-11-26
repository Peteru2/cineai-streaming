# CineAI: Trade-offs, Assumptions and What Changes at Scale

*Deliverable 03. This document defends the decisions behind the design in [DESIGN.md](DESIGN.md) and the code in this repository.*

## 1. The situation I solved for

Hammed is a founder with an indie streaming network, not a company with a platform team. He lost his premiere night to a handful of connected failures, and he has an engineering sync on Monday. He does not need a clever system. He needs one he can run, understand and trust, with a clear path from "works for a premiere" to "works for a business".

So every decision below was judged on four questions:

1. Does it remove a cause of a premiere-night failure, not only a symptom?
2. Can a small team operate it?
3. Can it be replaced later without rewriting everything?
4. What does it cost when it goes wrong?

## 2. Assumptions

I state these because several decisions depend on them. If one is wrong, the matching decision should be revisited.

| Assumption | If it is wrong |
|---|---|
| A premiere is tens of simultaneous uploads, not thousands | Queue, worker pool and database sizing change |
| Source files are mostly MP4 or MOV, up to a few GB, under an hour | Size and duration limits change; very long films need a different upload and processing plan |
| The sync complaints come from variable frame rate or timestamp drift in AI-generated files. **This is an inference from the symptoms, not something I observed.** | If the cause is elsewhere (for example the player), the sync fix will not help |
| Viewers are mostly on phones, many on constrained networks | The ladder's lowest rungs matter less, and higher bitrates could be offered |
| Hammed can use standard managed infrastructure (Postgres, Redis, object storage, a CDN) | The design would need to be self-hosted end to end, which is heavier |
| A creator who has not finished an upload within 24 hours has abandoned it | Slow uploaders get cut off (see 4.6) |

## 3. The core diagnosis

Nothing failed randomly. The system treated video as a small, ordinary web request, and video is large, arrives over unreliable networks, and must be consumed on very different devices. Each symptom is that one mistake in a different place. The design answers each cause, which is why it is a set of small mechanisms and not one big feature.

## 4. Decisions and trade-offs

### 4.1 Hybrid build, not "buy everything" and not "build everything"

**Decision.** I built the orchestration myself (upload flow, state machine, queue handling, workers, watchdog) and used standard parts underneath: Postgres, Redis, FFmpeg and S3-compatible object storage.

**Why.** The orchestration is where the failures were, and it is the part a vendor cannot hide from Hammed: if jobs get stuck, he needs to understand why. The parts underneath are commodity and replaceable.

**Alternative.** A managed video service (Cloudinary, Mux, Cloudflare Stream, AWS MediaConvert) would do upload, transcoding and delivery with far less code. For a founder with no platform team, that is genuinely attractive.

**What it costs.** More code and more to operate than a vendor, and I took on the bug surface of encoding settings and job handling myself.

**When I would change it.** At scale, or with a small team, the transcoding workers are the first thing I would hand to a managed service, keeping the queue and state machine in front of it. The system is already shaped for that swap: the worker's job is a single function behind an interface.

### 4.2 Uploads go straight to object storage, in chunks

**Decision.** The API issues signed URLs and keeps records. The browser sends 10 MB parts directly to storage as a multipart upload. The API never receives video bytes.

**Why.** Two separate causes were hiding here. Restarting from zero came from sending the file as one fragile request, and chunking fixes that. The 504 errors came from the API holding the file in memory, and bypassing the API fixes that. They need separate fixes, and I tested them separately.

**Alternative.** Streaming uploads through the API with a resumable protocol such as tus. That keeps one entry point but leaves the API doing heavy work, which is the constraint "the main server must stay responsive".

**What it costs.** The browser must be configured to talk to storage (CORS), and signed URLs expire, so the client has to refresh them. Resume depends on storage being the source of truth for which parts exist.

**Numbers I chose.** 10 MB parts (small enough to retry cheaply, large enough to limit request count), a 5 GB per-file cap, and a 1000-part ceiling. I did not measure these on real mobile networks. I would tune part size against real upload failure rates.

### 4.3 Streaming: an HLS quality ladder with constant frame rate

**Decision.** Each video is transcoded into up to four rungs (1080p at 5000 kbps, 720p at 2800, 480p at 1400, 360p at 700), cut into 4-second segments, forced to a constant 30 fps, with keyframes aligned across rungs and audio timestamps rebuilt. The ladder never upscales. The master playlist lists the lowest quality first.

**Why.** Viewers burned data and buffered because they received the master file. A ladder with short segments lets the player change quality at every segment boundary, so a weak connection gets a softer picture instead of a spinner. The priority is smoothness over sharpness.

**Alternatives.** A single 720p file (simpler, but no adaptation), or DASH instead of HLS (HLS has wider device support).

**What it costs.** Transcoding costs CPU time and storage (several copies of every film). Capping at 1080p saves money but means 4K masters are not offered to viewers.

**What I verified and what I did not.** I verified that a 25 fps synthetic source comes out at 30 fps in every segment. I did **not** verify the sync fix on real creator files, so I cannot claim the complaints are solved. The first week should include running Hammed's actual problem files through the pipeline.

### 4.4 Postgres is the source of truth, and the queue is only a wake-up call

**Decision.** Video state lives in Postgres. Redis holds job tickets, and a ticket only tells a worker to go and look. A worker must win an atomic claim in Postgres before doing anything. Retries are decided in Postgres by an attempt counter, not by the queue library.

**Why.** If Redis loses a ticket, or delivers one twice, nothing breaks: a duplicate claims nothing and exits, and a lost ticket is re-issued by the watchdog. State that matters is in one place that survives restarts.

**Alternative.** Let the queue library own retries and state. Less code, but state is split across two systems and harder to inspect.

**What it costs.** Extra Postgres writes per job, and I had to build the retry and recovery logic myself.

### 4.5 The attempt number is a lease token

**Decision.** Claiming a job increments an attempt counter. Every heartbeat and every completion must present that number, and the update only succeeds if it still matches.

**Why.** A heartbeat alone cannot stop a slow, replaced worker from overwriting the new worker's result. If worker A stalls, the watchdog re-queues the job, and worker B finishes it, A waking up late would write over B. With the token, A's writes match zero rows and A learns it lost the job and stops. This is a classic fencing technique, and it is the mechanism that replaced "hope" with "fact" for job ownership.

**What it costs.** One extra column and a slightly more careful update on every state change.

### 4.6 A watchdog that polls, instead of relying only on events

**Decision.** A scheduled process runs every 60 seconds and fixes four situations: workers silent for 120 seconds (re-queue, or fail after three attempts), uploads whose completion was lost but whose file exists, uploads unfinished after 24 hours, and videos whose queue ticket was dropped.

**Why.** Nothing can report its own death, so something separate has to notice by absence. It also covers hand-offs between components, where silent loss is most likely. Every fix is a compare-and-set, so running two watchdogs at once is safe and needs no coordination.

**Alternative.** Rely on queue stall detection and storage event notifications.

**What it costs.** Recovery is not instant: a dead worker is noticed within about two to three minutes. The 120-second threshold against a 30-second heartbeat is a deliberate balance, because a shorter threshold would steal jobs from healthy but slow workers. The scan also grows with the number of waiting records.

**When I would change it.** At larger scale I would add storage event notifications for fast completion detection, and keep the watchdog as the safety net.

### 4.7 No storage events: the browser calls complete

**Decision.** The browser tells the API when it has finished sending parts. The API checks storage itself (every part exists, the byte total matches the declared size) and ignores the browser's opinion. If the browser disappears, the watchdog finds the finished file.

**Why.** It needs no webhook support from the storage product, which mattered because I had to change storage mid-project (see section 5). It also means the API never trusts a client's claim about what was uploaded.

**What it costs.** If a creator closes the tab at the last moment, completion waits for the watchdog, up to several minutes.

### 4.8 Duplicate signals are made harmless, not prevented

**Decision.** Creating a video takes an idempotency key per creator, and changing a status is one SQL statement: set the new status only if the current one is the expected one, and write the audit event in the same transaction. Only the request that changes a row enqueues a job.

**Why.** Networks retry, people double-click, and notifications arrive twice. Trying to prevent duplicates is fragile. Making them harmless is robust. I proved it against real Postgres: five simultaneous completes give one status change, one audit event and one job.

### 4.9 Fail early and cheaply

**Decision.** Before spending CPU, the worker probes the file. A file with no video track, a corrupt container, an audio-only file, or one over 60 minutes or 4320 pixels tall is a permanent error: it fails at once with a reason and is never retried. Temporary errors retry up to three times. Every job has a 30-minute hard limit.

**Why.** Retrying a corrupt file three times is three wasted encodes, which is exactly the kind of loop that fed the billing spike. A hung FFmpeg would keep sending heartbeats and look healthy, so only a hard timeout catches it.

**What it costs.** A few good files might be rejected by overly strict probe rules. If one is, the reason is stored and shown, so it can be diagnosed.

### 4.10 Cost controls: what is built, and what is not

**Built:** size and type limits at upload start, resumable uploads so bytes travel once, probe before transcoding, a three-attempt cap, a job timeout, a 1080p ceiling, no raw masters served to viewers, aborting unfinished uploads after 24 hours, and an upload kill switch (`UPLOADS_ENABLED=false`) that pauses new uploads while playback continues.

**Not built:** rate limits, per-creator quotas, cold storage for old masters, budget alerts (a cloud-provider setting), and any measurement of real cost.

**Why the kill switch matters.** If Hammed gets a billing alert at 10 PM, the fastest safe move is to pause the part that is easy to pause, new uploads, and protect the part viewers see. It is one flag, reversible in a minute.

**What I did not do.** I did not estimate a monthly bill, because I have no real usage data and a made-up number would be worse than none.

### 4.11 Storage sits behind a small interface

**Decision.** Application code talks to an `ObjectStorage` interface, implemented once with the standard S3 SDK.

**Why.** It paid for itself during the build. MinIO was my first choice, but its public container images were removed while I was working. Switching to RustFS changed a compose file and one default, not the application. In production the same interface works with S3 or R2.

### 4.12 Local database for tests and development, hosted only as an option

**Decision.** Tests always use local Postgres in Docker, even if a hosted URL is configured.

**Why.** I tried a hosted database first. Every query crossed the internet, tests slowed from about 25 seconds to nearly three minutes and timed out whenever the connection stalled. Tests should be fast and isolated.

### 4.13 React and TypeScript for the frontend

**Decision.** A React and TypeScript app with a home page of films, an upload page, and a viewer page. The tested upload engine (chunking, retries, expired links, offline handling) is framework-independent.

**Why.** The product is expected to grow, and a component structure handles that better than hand-written page code. Keeping the logic out of the components made it testable without a browser.

**What it costs.** More tooling than a single HTML page. The player library is loaded only when a video is about to play, to keep the first page light for people on weak connections.

## 5. What the build taught me

These are real findings, not planned ones.

- **A dependency disappeared.** MinIO's images were removed mid-project. The storage interface made this a small change. Lesson: wrap dependencies you do not control.
- **Concurrency bugs show up only under concurrency.** Test files running in parallel exposed a race in schema migrations: two processes created the same tables at the same instant. The API, worker and watchdog start together in real use, so it was a real bug. A Postgres advisory lock fixed it.
- **My own tests were wrong more than once.** A test expected an old upload link to be reused after a refresh, and another simulated a connection that came back but stayed broken. In both cases the code was right and my assumption was wrong. Writing the test first made me state the intended behaviour precisely.
- **A missing optional package broke a library silently.** The queue library needed a separate Redis client package, and nothing worked until it was installed.
- **Environment details matter.** On Windows, `localhost` can resolve to IPv6 first, and another Postgres was already listening on the default port. I moved the project to host port 5433 and used `127.0.0.1`.

## 6. What is verified and what is not

**Verified by automated tests against real Postgres, Redis, storage and FFmpeg:** resumable uploads, refreshing expired links, early completion being refused, simultaneous duplicate signals producing one effect, the watchdog's recovery cases, lease fencing, retry limits, permanent versus temporary errors, constant frame rate on a synthetic clip, the browser access rules on storage, and one end-to-end run from upload to ready.

**Verified manually, once, on one machine:** uploading a real video through the browser, watching it process, and playing it back with quality levels.

**Not verified:**

- Load. I never tested 30 simultaneous uploads or 12,000 viewers. "The API stays responsive" follows from the design (it never touches video) but is a reasoned claim, not a measured one.
- Real creator files, including phone videos recorded sideways.
- Real mobile networks and a real CDN.
- The database being unavailable. The design promised a clean 503, but the API returns a generic 500.
- Whether the storage product honours a bucket lifecycle rule, which is the intended backstop for cleaning up half-finished uploads.

## 7. What Hammed should do, and in what order

**Before the next premiere (week one):**

1. Put real authentication in front of every creator route. Today identity is just a header.
2. Run his actual problem files through the pipeline and check audio sync, including a sideways phone video.
3. Load test: 30 simultaneous uploads, then a burst of viewers on a staging copy. Replace my reasoning with numbers.
4. Put a CDN in front of a **private** bucket, and set budget alerts at 50, 80 and 100 percent.
5. Add a published flag, so a film can be hidden until its scheduled premiere.
6. Make the database-down case return a clean 503, and add a health check that includes it.

**Later:**

- Handle transcoding with a managed service, keeping the queue and state machine in front of it.
- Add storage event notifications for fast completion detection, keeping the watchdog as a backstop.
- Add rate limits and per-creator quotas, notifications when a video is ready or has failed, a first-chunk hash check for resumed files, and pagination for the home page.
- Collect playback metrics (startup time, rebuffering, quality switches), because today nobody would know how often viewers buffer.
- Replace the simple migration runner with a tool that records which migrations have run.

## 8. What changes at scale

| Area | Today | At scale |
|---|---|---|
| Transcoding | Software FFmpeg on a few workers | Managed transcoding, or hardware encoding, with autoscaling and a hard ceiling |
| Delivery | Segments served from storage | CDN in front of a private bucket; playlists cached briefly, segments for a year |
| Completion detection | Browser call plus watchdog polling | Storage events as the fast path, watchdog as the safety net |
| Database | One Postgres | Managed Postgres with read replicas; archive old audit events |
| Queue | One Redis | Managed queue with persistence and alerts on depth and age |
| Identity and access | A header | Real accounts, roles, and private or scheduled films |
| Cost control | Limits and a kill switch | Budget alerts, per-creator quotas, rate limits, cold storage for old masters |
| Observability | Logs | Metrics, tracing, dashboards for queue depth, job age, failure rate and playback quality |
| Abandon rule | 24 hours since last change | Measure from the newest uploaded part |
| Migrations | Idempotent files under a lock | A migration tool that tracks applied versions |

## 9. The one-paragraph version

The failures came from treating video as a small web request. I fixed each cause directly: chunked uploads straight to storage so a drop costs one chunk and the API never holds a video, a queue with workers so heavy processing cannot starve the API, a state machine with heartbeats, lease tokens and a watchdog so no video can stay stuck, and an adaptive quality ladder so a phone on weak data gets smooth playback. I built the orchestration and used standard parts underneath because Hammed has no platform team. I tested the failure cases against real services, and I am clear about what I have not measured: load, real creator files, real networks, and a real CDN.
