'use strict';

const express = require('express');
const router  = express.Router();
const { spawn } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const PODCAST_DIR   = path.join(__dirname, '..', 'podcast');
const AUDIO_DIR     = path.join(PODCAST_DIR, 'audio');
const THUMBS_DIR    = path.join(PODCAST_DIR, 'thumbs');
const EPISODES_FILE = path.join(PODCAST_DIR, 'episodes.json');
const FEED_FILE     = path.join(PODCAST_DIR, 'feed.xml');

// Create dirs on startup (mirrors server.js lines 21-23)
[PODCAST_DIR, AUDIO_DIR, THUMBS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readEpisodes() {
  try {
    if (!fs.existsSync(EPISODES_FILE)) return [];
    return JSON.parse(fs.readFileSync(EPISODES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeEpisodes(episodes) {
  fs.writeFileSync(EPISODES_FILE, JSON.stringify(episodes, null, 2), 'utf8');
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateFeed(episodes) {
  const base   = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const title  = process.env.PODCAST_TITLE  || 'My Podcast';
  const author = process.env.PODCAST_AUTHOR || '';

  // Sort newest-first for podcast clients
  const sorted = [...episodes].sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const items = sorted.map(ep => {
    const h = Math.floor(ep.durationSeconds / 3600);
    const m = Math.floor((ep.durationSeconds % 3600) / 60);
    const s = ep.durationSeconds % 60;
    const durStr = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    const audioUrl = `${base}/audio/${ep.id}.mp3`;
    const thumbUrl = ep.thumbFile ? `${base}/thumbs/${ep.id}.jpg` : '';

    return `
    <item>
      <title>${escapeXml(ep.title)}</title>
      <description><![CDATA[${ep.description || ''}]]></description>
      <pubDate>${ep.pubDate}</pubDate>
      <enclosure url="${audioUrl}" length="${ep.fileSizeBytes}" type="audio/mpeg"/>
      <itunes:duration>${durStr}</itunes:duration>${thumbUrl ? `\n      <itunes:image href="${thumbUrl}"/>` : ''}
      <guid isPermaLink="true">${audioUrl}</guid>
    </item>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${base}</link>
    <description>${escapeXml(title)}</description>
    <language>en-us</language>
    <itunes:author>${escapeXml(author)}</itunes:author>
    <itunes:explicit>no</itunes:explicit>
    <itunes:image href="https://pub-c328e66e61d940b59da4f2b4c1ecf308.r2.dev/podcast-artwork.png"/>${items}
  </channel>
</rss>`;
}

function writeFeed(episodes) {
  fs.writeFileSync(FEED_FILE, generateFeed(episodes), 'utf8');
}

async function uploadEpisodeFilesToR2(id, hasThumbnail) {
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;
  if (!client || !bucket) return;

  const files = [];
  const mp3Path = path.join(AUDIO_DIR, `${id}.mp3`);
  if (fs.existsSync(mp3Path)) {
    files.push({ localPath: mp3Path, key: `audio/${id}.mp3`, contentType: 'audio/mpeg' });
  }
  if (hasThumbnail) {
    const thumbPath = path.join(THUMBS_DIR, `${id}.jpg`);
    if (fs.existsSync(thumbPath)) {
      files.push({ localPath: thumbPath, key: `thumbs/${id}.jpg`, contentType: 'image/jpeg' });
    }
  }

  for (const f of files) {
    try {
      const body = fs.readFileSync(f.localPath);
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: f.key,
        Body: body,
        ContentType: f.contentType,
      }));
    } catch (err) {
      console.error(`[podcast] R2 upload failed for ${f.key}:`, err.message);
    }
  }
}

async function uploadFeedToR2() {
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;
  if (!client || !bucket || !fs.existsSync(FEED_FILE)) return;
  try {
    const body = fs.readFileSync(FEED_FILE);
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: 'feed.xml',
      Body: body,
      ContentType: 'application/rss+xml',
    }));
  } catch (err) {
    console.error('[podcast] R2 feed upload failed:', err.message);
  }
}

function sseSetup(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function sseSend(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseEnd(res) {
  res.end();
}

function getR2Client() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
}

async function resolveThumbnail(id) {
  const jpgPath  = path.join(AUDIO_DIR, `${id}.jpg`);
  const webpPath = path.join(AUDIO_DIR, `${id}.webp`);
  const destPath = path.join(THUMBS_DIR, `${id}.jpg`);

  if (fs.existsSync(jpgPath)) {
    fs.renameSync(jpgPath, destPath);
    return true;
  }

  if (fs.existsSync(webpPath)) {
    try {
      // Deferred require so a missing sharp package doesn't crash on startup
      const sharp = require('sharp');
      await sharp(webpPath).jpeg({ quality: 90 }).toFile(destPath);
      fs.rmSync(webpPath, { force: true });
      return true;
    } catch (err) {
      console.error('[podcast] sharp thumbnail conversion failed:', err.message);
      return false;
    }
  }

  return false;
}

function cleanupPartial(id) {
  try {
    fs.readdirSync(AUDIO_DIR)
      .filter(f => f.startsWith(id))
      .forEach(f => fs.rmSync(path.join(AUDIO_DIR, f), { force: true }));
  } catch {}
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get('/episodes', (req, res) => {
  res.json(readEpisodes());
});

router.get('/thumb/:id', (req, res) => {
  const ep = readEpisodes().find(e => e.id === req.params.id);
  if (!ep || !ep.thumbFile) return res.status(404).json({ error: 'Not found' });
  const thumbPath = path.join(THUMBS_DIR, `${ep.id}.jpg`);
  if (!fs.existsSync(thumbPath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(thumbPath);
});

// ─── POST /episodes ───────────────────────────────────────────────────────────

router.post('/episodes', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  sseSetup(res);

  const id = uuidv4();

  sseSend(res, { type: 'progress', phase: 'downloading', pct: 0 });

  const ytdlp = spawn('yt-dlp', [
    '--extract-audio', '--audio-format', 'mp3',
    '--write-thumbnail', '--write-info-json',
    '--convert-thumbnails', 'jpg',
    '--newline',
    '-o', path.join(AUDIO_DIR, `${id}.%(ext)s`),
    url,
  ]);

  ytdlp.stdout.on('data', chunk => {
    const text = chunk.toString();

    const pctMatch = text.match(/\[download\]\s+([\d.]+)%/);
    if (pctMatch) {
      sseSend(res, { type: 'progress', phase: 'downloading', pct: Math.round(parseFloat(pctMatch[1])) });
    }
    if (text.includes('[ExtractAudio]')) {
      sseSend(res, { type: 'progress', phase: 'extracting' });
    }
    if (text.includes('[Metadata]') || text.includes('[EmbedThumbnail]') || text.includes('[ThumbnailsConvertor]')) {
      sseSend(res, { type: 'progress', phase: 'processing' });
    }
  });

  ytdlp.stderr.on('data', chunk => console.error('[podcast yt-dlp]', chunk.toString().trim()));

  ytdlp.on('error', err => {
    sseSend(res, { type: 'error', message: `Failed to start yt-dlp: ${err.message}. Is yt-dlp installed?` });
    sseEnd(res);
  });

  ytdlp.on('close', async code => {
    if (code !== 0) {
      cleanupPartial(id);
      sseSend(res, { type: 'error', message: `yt-dlp exited with code ${code}. Check that the URL is valid and publicly accessible.` });
      return sseEnd(res);
    }

    sseSend(res, { type: 'progress', phase: 'processing' });

    // Extract metadata from .info.json
    const infoPath = path.join(AUDIO_DIR, `${id}.info.json`);
    let title = 'Untitled';
    let description = '';
    let durationSeconds = 0;
    let pubDate = new Date().toUTCString();

    if (fs.existsSync(infoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        title           = info.title || 'Untitled';
        description     = info.description || '';
        durationSeconds = Math.round(info.duration || 0);
        if (info.upload_date && /^\d{8}$/.test(info.upload_date)) {
          const y  = info.upload_date.slice(0, 4);
          const mo = info.upload_date.slice(4, 6);
          const d  = info.upload_date.slice(6, 8);
          pubDate = new Date(`${y}-${mo}-${d}T12:00:00Z`).toUTCString();
        }
      } catch (err) {
        console.error('[podcast] failed to parse info.json:', err.message);
      }
      fs.rmSync(infoPath, { force: true });
    }

    // Get MP3 file size
    let fileSizeBytes = 0;
    try {
      fileSizeBytes = fs.statSync(path.join(AUDIO_DIR, `${id}.mp3`)).size;
    } catch {}

    // Resolve thumbnail (jpg preferred, webp fallback via sharp)
    const hasThumbnail = await resolveThumbnail(id);

    const episode = {
      id,
      title,
      description,
      pubDate,
      durationSeconds,
      fileSizeBytes,
      audioFile: `podcast/audio/${id}.mp3`,
      thumbFile: hasThumbnail ? `podcast/thumbs/${id}.jpg` : null,
    };

    // Prepend so newest appears first
    const episodes = [episode, ...readEpisodes()];
    writeEpisodes(episodes);
    writeFeed(episodes);
    sseSend(res, { type: 'progress', phase: 'uploading' });
    await uploadEpisodeFilesToR2(id, hasThumbnail);
    await uploadFeedToR2();

    sseSend(res, { type: 'done', episode });
    sseEnd(res);
  });
});

// ─── DELETE /episodes/:id ─────────────────────────────────────────────────────

router.delete('/episodes/:id', async (req, res) => {
  const { id } = req.params;
  const episodes = readEpisodes();
  const ep = episodes.find(e => e.id === id);
  if (!ep) return res.status(404).json({ error: 'Episode not found' });

  // Delete local files (force: true = no error if already gone)
  fs.rm(path.join(AUDIO_DIR, `${id}.mp3`),  { force: true }, () => {});
  fs.rm(path.join(THUMBS_DIR, `${id}.jpg`), { force: true }, () => {});

  // Delete from R2 if configured (treat 404 as no-op — may never have been deployed)
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;
  if (client && bucket) {
    for (const key of [`audio/${id}.mp3`, `thumbs/${id}.jpg`]) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        if (err.$metadata?.httpStatusCode !== 404 && err.name !== 'NotFound') {
          console.error(`[podcast] R2 delete failed for ${key}:`, err.message);
        }
      }
    }
  }

  const updated = episodes.filter(e => e.id !== id);
  writeEpisodes(updated);
  writeFeed(updated);
  await uploadFeedToR2();

  res.json({ ok: true });
});

// ─── POST /deploy ─────────────────────────────────────────────────────────────

router.post('/deploy', async (req, res) => {
  sseSetup(res);

  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;

  if (!client || !bucket) {
    sseSend(res, { type: 'error', message: 'R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME.' });
    return sseEnd(res);
  }

  const episodes = readEpisodes();
  writeFeed(episodes); // regenerate before deploy to ensure freshness

  // Always upload: feed.xml (changes every deploy)
  const alwaysUpload = [];

  if (fs.existsSync(FEED_FILE)) {
    alwaysUpload.push({ localPath: FEED_FILE, key: 'feed.xml', contentType: 'application/rss+xml' });
  }

  // Conditional upload: thumbnails + MP3s only if not already in R2
  const conditionalCandidates = [];

  for (const ep of episodes) {
    const thumbPath = path.join(THUMBS_DIR, `${ep.id}.jpg`);
    if (ep.thumbFile && fs.existsSync(thumbPath)) {
      conditionalCandidates.push({ localPath: thumbPath, key: `thumbs/${ep.id}.jpg`, contentType: 'image/jpeg' });
    }
  }

  for (const ep of episodes) {
    const mp3Path = path.join(AUDIO_DIR, `${ep.id}.mp3`);
    if (fs.existsSync(mp3Path)) {
      conditionalCandidates.push({ localPath: mp3Path, key: `audio/${ep.id}.mp3`, contentType: 'audio/mpeg' });
    }
  }

  sseSend(res, { type: 'progress', phase: 'checking', total: conditionalCandidates.length, checked: 0 });

  const toUpload = [];
  let skipped = 0;

  for (let i = 0; i < conditionalCandidates.length; i++) {
    const f = conditionalCandidates[i];
    sseSend(res, { type: 'progress', phase: 'checking', file: f.key, checked: i + 1, total: conditionalCandidates.length });
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: f.key }));
      skipped++; // exists in R2 — skip
    } catch (err) {
      const status = err.$metadata?.httpStatusCode;
      if (status === 404 || err.name === 'NotFound') {
        toUpload.push(f); // not in R2 — upload
      } else {
        sseSend(res, { type: 'error', message: `R2 check failed for ${f.key}: ${err.message}` });
        return sseEnd(res);
      }
    }
  }

  const uploadList = [...alwaysUpload, ...toUpload];
  sseSend(res, { type: 'progress', phase: 'uploading', total: uploadList.length, uploaded: 0 });

  for (let i = 0; i < uploadList.length; i++) {
    const f = uploadList[i];
    sseSend(res, { type: 'progress', phase: 'uploading', file: f.key, uploaded: i, total: uploadList.length });
    try {
      const body = fs.readFileSync(f.localPath);
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: f.key,
        Body: body,
        ContentType: f.contentType,
      }));
    } catch (err) {
      sseSend(res, { type: 'error', message: `Upload failed for ${f.key}: ${err.message}` });
      return sseEnd(res);
    }
  }

  sseSend(res, { type: 'done', uploaded: uploadList.length, skipped });
  sseEnd(res);
});

module.exports = router;
