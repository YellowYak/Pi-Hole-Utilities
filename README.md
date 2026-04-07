# Pi Utilities

Four self-hosted utilities running on your Pi-hole device. (This document assumes the Pi-hole device is accessible on the local network via IP address 192.168.1.69 and/or the domain name `pihole.local`. Update the instructions below to use whatever IP address and/or domain name that is applicable for the Pi-hole on your network.)

| Page | URL |
|---|---|
| Dashboard | http://pihole.local:3000/ |
| Video → MP3 | http://pihole.local:3000/video.html |
| YouTube → MP3 | http://pihole.local:3000/youtube.html |
| NBA Watchability | http://pihole.local:3000/nba.html |
| Podcast | http://pihole.local:3000/podcast.html |

---

## Docker deployment

The recommended way to run Pi Utilities is via Docker. Two containers are
managed by `docker-compose.yml`: the Node/Express app (`pi-utilities`) and the
NBA Watchability scoring API (`nba-game-score-api`).

### First-time Pi setup

**1. Install Docker on the Pi:**
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker pi
```

Log out and back in for the group change to take effect.

**2. Authenticate with GitHub Container Registry:**
```bash
echo YOUR_GHCR_TOKEN | docker login ghcr.io -u yellowyak --password-stdin
```

**3. Clone the repo:**
```bash
git clone https://github.com/YellowYak/Pi-Hole-Utilities.git pi-utilities
cd pi-utilities
```

**4. Start the services:**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Docker will pull both images from GitHub Container Registry and start the
containers. The app will be available at `http://pihole.local:3000`.

---

### Updating to a new version

After pushing updated images to GHCR, pull and restart on the Pi:

```bash
git pull   # picks up any compose file changes
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**First-time secrets setup:** The podcast feature reads R2 credentials from a
`.env` file in the project root (never committed). Copy the template and fill
in your values once on the Pi:

```bash
cp .env.example .env
nano .env
```

Docker Compose reads `.env` automatically — no extra flags needed.

---

### Development workflow (local Windows machine)

Build images locally from sibling repos:

```bash
cd ../NbaGameScoreApi && docker build -t nba-game-score-api .
cd ../Pi\ Hole\ Utilities && docker build -t pi-utilities .
docker compose up
```

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

Docker's layer caching makes rebuilds fast when only `server.js` has changed —
the dependency install layers will be cached and only the final
`COPY server.js .` layer will rerun.

**Publishing updated images to GHCR (multi-platform):**

Both `amd64` (dev machine) and `arm64` (Pi) variants must be built and pushed
together using `buildx`:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/yellowyak/pi-utilities:latest \
  --push .
```

> **Troubleshooting:** If the build fails with `exec format error` on `linux/arm64`,
> the active buildx builder may be using the `docker` driver, which doesn't support
> cross-platform builds. Fix it by creating a proper builder:
> ```bash
> docker buildx create --use --bootstrap
> ```

---

### Logs

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f
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
