# Pi Utilities

Four self-hosted utilities running on your Pi-hole device. (This document assumes the Pi-hole device is accessible on the local network via IP address 192.168.1.69 and/or the domain name `pihole.local`. Update the instructions below to use whatever IP address and/or domain name that is applicable for the Pi-hole on your network.)

| Page | URL |
|---|---|
| Dashboard | http://pihole.local:3000/ |
| Video → MP3 | http://pihole.local:3000/video.html |
| YouTube → MP3 | http://pihole.local:3000/youtube.html |
| NBA Watchability | http://pihole.local:3000/nba.html |

---

## Prerequisites

### Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version && npm --version
```

### ffmpeg
```bash
sudo apt install -y ffmpeg
```

### yt-dlp
```bash
sudo apt install -y python3-pip
sudo pip3 install yt-dlp --break-system-packages
yt-dlp --version
```

Keep yt-dlp current — YouTube changes its internals frequently. Update via pip:
```bash
sudo pip3 install -U yt-dlp --break-system-packages
```

To automate this, add a weekly cron job (runs as root, so no sudo prefix needed):
```bash
sudo crontab -e
```
Add:
```
0 3 * * 0 pip3 install -U yt-dlp --break-system-packages >> /var/log/yt-dlp-update.log 2>&1
```

### nba_watchability sidecar API

The NBA Watchability page calls a sidecar HTTP service. Set the `NBA_API_URL`
environment variable to point at it (defaults to `http://localhost:8000`).

The sidecar must expose `GET /score/{date}` (date in `YYYYMMDD` format) and
return a JSON array of game results.

---

## Docker (alternative deployment)

A `docker-compose.yml` is provided to run both the pi-utilities server and the
NBA sidecar API as containers. Build the NBA API image first from its own repo:

```bash
cd ../NbaGameScoreApi && docker build -t nba-game-score-api .
cd ../Pi\ Hole\ Utilities && docker build -t pi-utilities .
docker compose up -d
```

### Development workflow

A `docker-compose.override.yml` is provided for local development. It mounts
`public/` directly from the host filesystem into the container, so changes to
any file in `public/` (HTML, CSS, JS) are reflected immediately on browser
refresh — no rebuild required.

The override file is excluded from source control (`.gitignore`) and is only
active on your dev machine. It is not used in production/Pi deployments.

**What requires a rebuild:**

Changes to files outside `public/` — particularly `server.js`, `package.json`,
or the `Dockerfile` itself — are baked into the image and require a full
rebuild to take effect:

```bash
docker compose down
docker build -t pi-utilities .
docker compose up
```

Note that Docker's layer caching makes rebuilds fast when only `server.js` has
changed — the dependency install layers will be cached and only the final
`COPY server.js .` layer will rerun.

---

## Installation

```bash
scp -r ./video-converter pi@192.168.1.69:/home/pi/video-converter
ssh pi@192.168.1.69
cd /home/pi/video-converter
npm install
```

---

## Test manually first

```bash
node server.js
```

Verify all pages work before setting up the service:
- http://pihole.local:3000/ — Dashboard with system stats
- http://pihole.local:3000/video.html — upload a video, verify MP3 download works
- http://pihole.local:3000/youtube.html — paste a YouTube URL, verify MP3/ZIP download works
- http://pihole.local:3000/nba.html — enter a past date, verify game scores load

---

## Set up as a systemd service (auto-start on boot)

```bash
sudo cp /home/pi/video-converter/video-converter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable video-converter
sudo systemctl start video-converter
sudo systemctl status video-converter
```

---

## Configure lighttpd proxy (optional)

To access via http://pihole.local/mysite instead of port 3000:

```bash
sudo nano /etc/lighttpd/lighttpd.conf
```

Add:
```
server.modules += ( "mod_proxy" )

$HTTP["url"] =~ "^/mysite" {
    proxy.server = ( "" => (( "host" => "127.0.0.1", "port" => 3000 )))
    proxy.header = ( "map-urlpath" => ( "/mysite" => "" ) )
}
```

```bash
sudo service lighttpd restart
```

---

## Logs

```bash
sudo journalctl -u video-converter -f
```
