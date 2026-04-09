# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Pi Utilities is a self-hosted Node.js/Express web app that runs on a Raspberry Pi alongside Pi-hole. It provides five browser-based utilities accessible over the local network:

- **Dashboard** (`/`) — System stats (memory, disk, CPU temp, uptime, active jobs)
- **Video → MP3** (`/video.html`) — Upload a video file and convert it to MP3 via ffmpeg
- **YouTube → MP3** (`/youtube.html`) — Download audio from YouTube URLs via yt-dlp, packaged as ZIP for playlists
- **NBA Watchability** (`/nba.html`) — Score NBA games by "worth watching" via a companion API
- **Podcast** (`/podcast.html`) — Download YouTube videos as audio, manage episodes, sync channel subscriptions, and publish an RSS feed to Cloudflare R2

## Running and Building

**Local development** (Windows, with hot-reload for `public/`):
```bash
docker build -t pi-utilities .
docker compose up
```
`docker-compose.override.yml` is gitignored and mounts `public/` as a volume for hot-reload.

**Production build** (multi-platform image for Pi):
```bash
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/yellowyak/pi-utilities:latest --push .
```

**Production deployment** (on the Pi):
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Logs:**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f
```

There is no test suite.

## Architecture

### Backend (`server.js` + `routes/podcast.js`)

**`server.js`** — Main Express app. Handles video conversion, YouTube downloading, NBA scoring, system stats, and mounts the podcast router. Key patterns:
- In-memory `jobs` object (keyed by UUID) tracks async operations with status/progress
- Periodic cleanup (every 15 min) removes jobs older than 1 hour
- Child processes spawned for `ffmpeg` (video conversion) and `yt-dlp` (YouTube download)

**`routes/podcast.js`** — All podcast logic. Manages episode and channel state in JSON files on disk. Key behaviors:
- Episodes stored in `podcast/episodes.json`, channels in `podcast/channels.json`
- Server-Sent Events (SSE) used for streaming progress on long-running operations (episode add, channel sync, deploy)
- Channel sync runs automatically via `node-cron` every 4 hours; yt-dlp auto-updates Sundays at 3am
- Thumbnails converted from webp→JPEG using `sharp`; uploaded alongside MP3s to Cloudflare R2 (S3-compatible via `@aws-sdk/client-s3`)
- RSS feed regenerated and uploaded to R2 on every episode add/delete

### Frontend (`public/*.html`)

Each page is a self-contained SPA using vanilla HTML/CSS/JavaScript — no build step, no framework. Pages communicate with the backend via `fetch()` REST calls and SSE (`EventSource`). `podcast.html` is the most complex page (~34 KB).

### Data Flow Highlights

**Adding a podcast episode:**
1. POST `/podcast/episodes` with YouTube URL
2. yt-dlp spawned; progress streamed via SSE
3. Metadata parsed from `info.json`; thumbnail converted if needed
4. Episode prepended to `episodes.json`; `feed.xml` regenerated
5. MP3 + thumbnail + feed uploaded to R2

**Channel sync (cron or manual):**
1. yt-dlp fetches recent video IDs, filtered by `--dateafter {lastSynced}`
2. New IDs deduped against existing `episodes.youtubeId` values
3. Each new video downloaded via the same flow as manual episode add
4. Sync results appended to `sync-log.json` (max 100 entries)

### External Dependencies

- **ffmpeg** — video conversion (installed in Docker image)
- **yt-dlp** — YouTube download (installed via pip3 in Docker image)
- **Cloudflare R2** — S3-compatible storage for podcast audio, thumbnails, and feed
- **`nba-game-score-api`** — companion Docker service (sibling repo) at `NBA_API_URL`

## Environment Variables

Defined in `.env` (see `.env.example`); injected via `docker-compose.yml`:

| Variable | Purpose |
|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare R2 credentials |
| `R2_BUCKET_NAME` | R2 bucket for podcast files |
| `R2_PUBLIC_BASE_URL` | Public CDN URL for R2 (e.g. `https://pub-xxxx.r2.dev`) |
| `PODCAST_TITLE`, `PODCAST_AUTHOR` | RSS feed metadata |
| `NBA_API_URL` | URL for NBA scoring API (default: `http://nba-api:8000`) |
| `SHARED_DIR` | Path to shared folder reported in dashboard stats |

## File Layout

```
server.js              # Main Express app
routes/podcast.js      # Podcast router (episodes, channels, RSS, R2)
public/                # Static SPA pages (no build step)
podcast/               # Persistent data: episodes.json, channels.json, feed.xml, sync-log.json, audio/, thumbs/
uploads/               # Temp: video uploads
outputs/               # Temp: ffmpeg output
youtube-outputs/       # Temp: yt-dlp downloads
Dockerfile
docker-compose.yml
docker-compose.prod.yml
docker-compose.override.yml  # gitignored; used for local dev hot-reload
```
