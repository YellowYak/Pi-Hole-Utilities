const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Directories
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
const OUTPUT_DIR  = path.join(__dirname, 'outputs');
const YOUTUBE_DIR = path.join(__dirname, 'youtube-outputs');
const NBA_API_URL  = process.env.NBA_API_URL || 'http://localhost:8000';

[UPLOAD_DIR, OUTPUT_DIR, YOUTUBE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error(`Unsupported file type: ${ext}`));
  }
});

const jobs = {};

app.use(express.static(path.join(__dirname, 'public')));
app.use('/podcast', require('./routes/podcast'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeToSeconds(t) {
  const [h, m, s] = t.split(':');
  return parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(s);
}

function cleanupPath(p) {
  if (!p) return;
  fs.rm(p, { recursive: true, force: true }, () => {});
}


// ─── Video → MP3 ─────────────────────────────────────────────────────────────

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const jobId = uuidv4();
  const inputPath = req.file.path;
  const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
  const outputFilename = `${baseName}.mp3`;
  const outputPath = path.join(OUTPUT_DIR, `${jobId}-${outputFilename}`);

  jobs[jobId] = {
    type: 'video', status: 'processing', conversionProgress: 0,
    outputPath, outputFilename, inputPath, error: null, createdAt: Date.now()
  };

  res.json({ jobId });

  let totalDuration = 0;
  const ffmpeg = spawn('ffmpeg', ['-i', inputPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', '-y', outputPath]);

  ffmpeg.stderr.on('data', chunk => {
    const text = chunk.toString();
    const dur = text.match(/Duration:\s*(\d+:\d+:\d+\.\d+)/);
    if (dur) totalDuration = timeToSeconds(dur[1]);
    const t = text.match(/time=(\d+:\d+:\d+\.\d+)/);
    if (t && totalDuration > 0)
      jobs[jobId].conversionProgress = Math.min(99, Math.round((timeToSeconds(t[1]) / totalDuration) * 100));
  });

  ffmpeg.on('close', code => {
    cleanupPath(inputPath);
    if (code === 0) { jobs[jobId].status = 'done'; jobs[jobId].conversionProgress = 100; }
    else { jobs[jobId].status = 'error'; jobs[jobId].error = `ffmpeg exited with code ${code}`; cleanupPath(outputPath); }
  });

  ffmpeg.on('error', err => {
    jobs[jobId].status = 'error';
    jobs[jobId].error = `Failed to start ffmpeg: ${err.message}. Is ffmpeg installed?`;
    cleanupPath(inputPath);
  });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, conversionProgress: job.conversionProgress, filename: job.status === 'done' ? job.outputFilename : null, error: job.error });
});

app.get('/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'Conversion not complete' });
  res.download(job.outputPath, job.outputFilename, err => {
    if (err) { console.error('Download error:', err); return; }
    setTimeout(() => { cleanupPath(job.outputPath); delete jobs[req.params.jobId]; }, 10_000);
  });
});

// ─── YouTube → MP3 ───────────────────────────────────────────────────────────

app.post('/youtube/submit', (req, res) => {
  const { url } = req.body;
  if (!url || !url.match(/youtube\.com|youtu\.be/i))
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  const jobId  = uuidv4();
  const jobDir = path.join(YOUTUBE_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  jobs[jobId] = {
    type: 'youtube', status: 'processing',
    phase: 'downloading',
    itemCurrent: 0, itemTotal: 0, itemProgress: 0, overallProgress: 0,
    outputType: null, outputPath: null, outputFilename: null,
    jobDir, error: null, createdAt: Date.now()
  };

  res.json({ jobId });

  const ytdlp = spawn('yt-dlp', [
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--embed-thumbnail', '--embed-metadata',
    '--sleep-interval', '5', '--newline',
    '-o', path.join(jobDir, '%(title)s.%(ext)s'),
    url
  ]);

  ytdlp.stdout.on('data', chunk => {
    const text = chunk.toString();

    const itemMatch = text.match(/Downloading item (\d+) of (\d+)/);
    if (itemMatch) {
      jobs[jobId].itemCurrent  = parseInt(itemMatch[1]);
      jobs[jobId].itemTotal    = parseInt(itemMatch[2]);
      jobs[jobId].itemProgress = 0;
    }

    const pctMatch = text.match(/\[download\]\s+([\d.]+)%/);
    if (pctMatch) {
      const pct = parseFloat(pctMatch[1]);
      jobs[jobId].itemProgress = pct;
      if (jobs[jobId].itemTotal > 0) {
        const done = jobs[jobId].itemCurrent - 1;
        jobs[jobId].overallProgress = Math.min(99, Math.round(((done + pct / 100) / jobs[jobId].itemTotal) * 100));
      } else {
        jobs[jobId].overallProgress = Math.min(99, Math.round(pct));
      }
    }

    if (text.includes('[ExtractAudio]'))                                         jobs[jobId].phase = 'extracting';
    if (text.includes('[EmbedThumbnail]') || text.includes('[embed'))            jobs[jobId].phase = 'processing';
  });

  ytdlp.stderr.on('data', chunk => console.error('[yt-dlp]', chunk.toString().trim()));

  ytdlp.on('close', async code => {
    if (code !== 0) {
      jobs[jobId].status = 'error';
      jobs[jobId].error  = `yt-dlp exited with code ${code}. Check that the URL is valid and publicly accessible.`;
      cleanupPath(jobDir);
      return;
    }

    try {
      const files = fs.readdirSync(jobDir).filter(f => f.toLowerCase().endsWith('.mp3'));

      if (files.length === 0) {
        jobs[jobId].status = 'error';
        jobs[jobId].error  = 'No MP3 files were produced. The video may have no audio track.';
        cleanupPath(jobDir);
        return;
      }

      if (files.length === 1) {
        jobs[jobId].outputType     = 'single';
        jobs[jobId].outputPath     = path.join(jobDir, files[0]);
        jobs[jobId].outputFilename = files[0];
        jobs[jobId].status         = 'done';
        jobs[jobId].overallProgress = 100;
      } else {
        jobs[jobId].phase = 'packaging';

        const zipFilename = `playlist-${jobId.slice(0, 8)}.zip`;
        const zipPath     = path.join(YOUTUBE_DIR, zipFilename);

        await new Promise((resolve, reject) => {
          const output  = fs.createWriteStream(zipPath);
          const archive = archiver('zip', { zlib: { level: 6 } });
          output.on('close', resolve);
          archive.on('error', reject);
          archive.pipe(output);
          files.sort().forEach(file => archive.file(path.join(jobDir, file), { name: file }));
          archive.finalize();
        });

        cleanupPath(jobDir);

        jobs[jobId].outputType     = 'playlist';
        jobs[jobId].outputPath     = zipPath;
        jobs[jobId].outputFilename = zipFilename;
        jobs[jobId].jobDir         = null;
        jobs[jobId].status         = 'done';
        jobs[jobId].overallProgress = 100;
      }
    } catch (err) {
      jobs[jobId].status = 'error';
      jobs[jobId].error  = `Post-processing failed: ${err.message}`;
      cleanupPath(jobDir);
    }
  });

  ytdlp.on('error', err => {
    jobs[jobId].status = 'error';
    jobs[jobId].error  = `Failed to start yt-dlp: ${err.message}. Is yt-dlp installed?`;
    cleanupPath(jobDir);
  });
});

app.get('/youtube/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.type !== 'youtube') return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status, phase: job.phase,
    itemCurrent: job.itemCurrent, itemTotal: job.itemTotal, itemProgress: job.itemProgress,
    overallProgress: job.overallProgress, outputType: job.outputType,
    filename: job.status === 'done' ? job.outputFilename : null,
    error: job.error
  });
});

app.get('/youtube/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.type !== 'youtube') return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'Download not ready' });
  res.download(job.outputPath, job.outputFilename, err => {
    if (err) { console.error('Download error:', err); return; }
    setTimeout(() => {
      cleanupPath(job.outputPath);
      if (job.jobDir) cleanupPath(job.jobDir);
      delete jobs[req.params.jobId];
    }, 10_000);
  });
});

// ─── NBA Watchability ─────────────────────────────────────────────────────────

app.post('/nba/submit', async (req, res) => {
  const { date } = req.body;
  if (!date || !/^\d{8}$/.test(date))
    return res.status(400).json({ error: 'Please provide a valid date in YYYYMMDD format.' });

  const jobId = uuidv4();
  jobs[jobId] = { type: 'nba', status: 'processing', date, result: null, error: null, createdAt: Date.now() };
  res.json({ jobId });

  try {
    const response = await fetch(`${NBA_API_URL}/score/${date}`);
    if (!response.ok) {
      let detail = `NBA API returned ${response.status}`;
      try { const body = await response.json(); if (body.detail) detail = body.detail; } catch (_) {}
      jobs[jobId].status = 'error';
      jobs[jobId].error  = detail;
      return;
    }
    const parsed = await response.json();
    if (!Array.isArray(parsed)) throw new Error('Expected a JSON array');
    jobs[jobId].result = parsed;
    jobs[jobId].status = 'done';
  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].error  = `NBA API request failed: ${err.message}`;
  }
});

app.get('/nba/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.type !== 'nba') return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, date: job.date, result: job.status === 'done' ? job.result : null, error: job.error });
});

// ─── Periodic cleanup ─────────────────────────────────────────────────────────

setInterval(() => {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  for (const [jobId, job] of Object.entries(jobs)) {
    if (now - job.createdAt > ONE_HOUR) {
      if (job.type === 'video') { cleanupPath(job.inputPath); cleanupPath(job.outputPath); }
      if (job.type === 'youtube') { cleanupPath(job.outputPath); if (job.jobDir) cleanupPath(job.jobDir); }
      delete jobs[jobId];
    }
  }
}, 15 * 60 * 1000);

// ─── System Info API ──────────────────────────────────────────────────────────

function execPromise(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

app.get('/api/system', async (req, res) => {
  try {
    const sharedDir  = process.env.SHARED_DIR || path.join(os.homedir(), 'shared');

    // Memory (from /proc/meminfo for accuracy)
    const memTotal = os.totalmem();
    const memFree  = os.freemem();
    const memUsed  = memTotal - memFree;

    // Disk space for root filesystem
    const dfOut  = await execPromise('df -B1 --output=size,used,avail /');
    const dfLines = dfOut.split('\n').filter(l => l.trim() && !l.startsWith('1B'));
    const dfParts = dfLines[0]?.trim().split(/\s+/) || [];
    const disk = {
      total: parseInt(dfParts[0]) || 0,
      used:  parseInt(dfParts[1]) || 0,
      avail: parseInt(dfParts[2]) || 0,
    };

    // CPU temperature (Pi-specific)
    const tempRaw = await execPromise('cat /sys/class/thermal/thermal_zone0/temp');
    const cpuTemp = tempRaw ? (parseInt(tempRaw) / 1000).toFixed(1) : null;

    // System uptime
    const uptimeSecs = os.uptime();
    const uptimeDays  = Math.floor(uptimeSecs / 86400);
    const uptimeHours = Math.floor((uptimeSecs % 86400) / 3600);
    const uptimeMins  = Math.floor((uptimeSecs % 3600) / 60);
    const uptime = uptimeDays > 0
      ? `${uptimeDays}d ${uptimeHours}h ${uptimeMins}m`
      : uptimeHours > 0
        ? `${uptimeHours}h ${uptimeMins}m`
        : `${uptimeMins}m`;

    // Load average
    const loadAvg = os.loadavg().map(v => v.toFixed(2));

    // yt-dlp version
    const ytdlpVersion = await execPromise('yt-dlp --version');

    // Shared folder stats
    let sharedStats = null;
    if (fs.existsSync(sharedDir)) {
      const allEntries  = fs.readdirSync(sharedDir, { withFileTypes: true });
      const files       = allEntries.filter(e => e.isFile());
      const dirs        = allEntries.filter(e => e.isDirectory());
      const duOut       = await execPromise(`du -sb "${sharedDir}"`);
      const duBytes     = parseInt(duOut.split('\t')[0]) || 0;
      sharedStats = {
        fileCount: files.length,
        dirCount:  dirs.length,
        totalBytes: duBytes,
        exists: true
      };
    } else {
      sharedStats = { exists: false };
    }

    // Active jobs summary
    const activeJobs = Object.values(jobs).filter(j => j.status === 'processing').length;

    res.json({
      memory: { total: memTotal, used: memUsed, free: memFree },
      disk,
      cpuTemp,
      uptime,
      loadAvg,
      ytdlpVersion: ytdlpVersion || 'unknown',
      shared: sharedStats,
      activeJobs,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Pi utilities running at http://localhost:${PORT}`);
  console.log(`  Video → MP3:       http://localhost:${PORT}/`);
  console.log(`  YouTube → MP3:     http://localhost:${PORT}/youtube.html`);
  console.log(`  NBA Watchability:  http://localhost:${PORT}/nba.html`);
  console.log(`  Podcast:           http://localhost:${PORT}/podcast.html`);
});
