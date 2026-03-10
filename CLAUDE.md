# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Server

```bash
node server.js
```

The server runs on port 3000. No build step required.

## Deployment

Files are copied to the Pi-hole device and dependencies installed there:

```bash
scp -r ./video-converter pi@192.168.1.69:/home/pi/video-converter
ssh pi@192.168.1.69
cd /home/pi/video-converter
npm install
```

Systemd service management:
```bash
sudo systemctl start video-converter
sudo systemctl status video-converter
sudo journalctl -u video-converter -f
```

## Architecture

Single-file Express backend (`server.js`) serving three HTML UIs. No frontend framework or build toolchain.

**Pages:**
- `/` — Dashboard polling `/api/system` every 5s for memory, disk, CPU temp, uptime, load average, and yt-dlp version
- `/video.html` — Upload video files (up to 4GB); ffmpeg extracts audio as MP3
- `/youtube.html` — Submit YouTube URLs; yt-dlp downloads and converts to MP3; playlists are auto-zipped

**Job system:** In-memory job map keyed by UUID. Jobs expire after 1 hour; a 15-minute interval cleans up expired jobs and their temp files. Both job types (`video`, `youtube`) share the same map and status/download route patterns.

**Temp directories created at runtime** (not in repo):
- `uploads/` — incoming video files
- `outputs/` — converted MP3s from video uploads
- `youtube-outputs/` — MP3s and ZIP archives from YouTube downloads

**External tool dependencies** (must be installed on the Pi):
- `ffmpeg` — video-to-MP3 conversion
- `yt-dlp` — YouTube downloading; keep updated weekly as YouTube changes frequently

**npm dependencies:** `express`, `multer`, `archiver`, `uuid`
