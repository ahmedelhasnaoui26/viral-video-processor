/**
 * FFmpeg video processor for Extend Video:
 * - extract-last-frame: last frame of a clip → JPEG on R2
 * - merge-clips: concat MP4s → single output on R2
 *
 * Deploy: Docker, Fly.io, Railway, or any host with ffmpeg.
 * Set VIDEO_PROCESSOR_TOKEN and expose PORT (default 8080).
 */
import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fetch from 'node-fetch';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json({ limit: '64mb' }));

const TOKEN = process.env.VIDEO_PROCESSOR_TOKEN?.trim() ?? '';
const PORT = Number(process.env.PORT ?? 8080);

function auth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!TOKEN || token !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function downloadToFile(url, destPath, maxAttempts = 4) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url);
    if (response.ok && response.body) {
      await pipeline(response.body, createWriteStream(destPath));
      return;
    }
    lastStatus = response.status;
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error(`Download failed (${lastStatus})`);
}

async function uploadFile(url, filePath, contentType) {
  const buffer = await fs.readFile(filePath);
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: buffer,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed (${response.status}): ${text.slice(0, 120)}`);
  }
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractFrameJpeg(videoPath, framePath) {
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .inputOptions(['-sseof', '-0.5'])
      .outputOptions(['-vframes', '1', '-q:v', '2'])
      .output(framePath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

/** POST /extract-last-frame-bytes — clip MP4 as base64 → JPEG base64 (no R2 download) */
app.post('/extract-last-frame-bytes', auth, async (req, res) => {
  const { videoBase64 } = req.body ?? {};
  if (!videoBase64) {
    return res.status(400).json({ error: 'videoBase64 required' });
  }

  try {
    const frameBase64 = await withTempDir(async (dir) => {
      const videoPath = path.join(dir, 'clip.mp4');
      const framePath = path.join(dir, 'frame.jpg');
      const buffer = Buffer.from(videoBase64, 'base64');
      if (buffer.byteLength < 1000) {
        throw new Error('videoBase64 too small');
      }
      await fs.writeFile(videoPath, buffer);
      await extractFrameJpeg(videoPath, framePath);
      return (await fs.readFile(framePath)).toString('base64');
    });

    res.json({ ok: true, frameBase64 });
  } catch (error) {
    console.error('[extract-last-frame-bytes]', error);
    res.status(500).json({ error: error.message ?? 'extract failed' });
  }
});

/** POST /extract-last-frame — return JPEG as base64 (preferred) or PUT to frameUploadUrl */
app.post('/extract-last-frame', auth, async (req, res) => {
  const { sourceDownloadUrl, frameUploadUrl, returnFrame } = req.body ?? {};
  if (!sourceDownloadUrl) {
    return res.status(400).json({ error: 'sourceDownloadUrl required' });
  }
  if (!returnFrame && !frameUploadUrl) {
    return res.status(400).json({
      error: 'Set returnFrame:true or provide frameUploadUrl',
    });
  }

  try {
    const frameBase64 = await withTempDir(async (dir) => {
      const videoPath = path.join(dir, 'clip.mp4');
      const framePath = path.join(dir, 'frame.jpg');

      await downloadToFile(sourceDownloadUrl, videoPath);

      await extractFrameJpeg(videoPath, framePath);

      if (returnFrame) {
        const buffer = await fs.readFile(framePath);
        return buffer.toString('base64');
      }

      if (frameUploadUrl) {
        await uploadFile(frameUploadUrl, framePath, 'image/jpeg');
        return null;
      }
    });

    if (returnFrame) {
      if (!frameBase64) {
        return res.status(500).json({ error: 'Frame extraction produced no data' });
      }
      return res.json({ ok: true, frameBase64 });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[extract-last-frame]', error);
    res.status(500).json({ error: error.message ?? 'extract failed' });
  }
});

/** POST /merge-clips */
app.post('/merge-clips', auth, async (req, res) => {
  const { clipDownloadUrls, outputUploadUrl } = req.body ?? {};
  if (!Array.isArray(clipDownloadUrls) || clipDownloadUrls.length < 1 || !outputUploadUrl) {
    return res.status(400).json({ error: 'clipDownloadUrls[] and outputUploadUrl required' });
  }

  try {
    const bytesWritten = await withTempDir(async (dir) => {
      const clipPaths = [];
      for (let i = 0; i < clipDownloadUrls.length; i++) {
        const clipPath = path.join(dir, `clip-${String(i).padStart(3, '0')}.mp4`);
        await downloadToFile(clipDownloadUrls[i], clipPath);
        clipPaths.push(clipPath);
      }

      const listPath = path.join(dir, 'concat.txt');
      const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
      await fs.writeFile(listPath, listContent, 'utf8');

      const outputPath = path.join(dir, `merged-${randomUUID()}.mp4`);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      const stat = await fs.stat(outputPath);
      await uploadFile(outputUploadUrl, outputPath, 'video/mp4');
      return stat.size;
    });

    res.json({ ok: true, bytesWritten });
  } catch (error) {
    console.error('[merge-clips]', error);
    res.status(500).json({ error: error.message ?? 'merge failed' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'cinemorph-video-processor' });
});

app.listen(PORT, () => {
  console.log(`Video processor listening on :${PORT}`);
});
