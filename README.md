# Cinemorph Video Processor

FFmpeg service for **Extend Video** (15s / 30s / 60s):

- `POST /extract-last-frame` — last frame of a clip → JPEG (base64 or R2 upload)
- `POST /extract-last-frame-bytes` — clip MP4 base64 → JPEG base64
- `POST /merge-clips` — concat MP4s → single output on R2
- `GET /health` — health check

Required for extended durations. **5s-only** generation does not need this service.

## Deploy on Railway (recommended)

### Option A — GitHub (monorepo)

1. **Push this folder to GitHub first** (Railway builds from GitHub, not your Mac):

```bash
cd "/path/to/viral_imagetovideo_app"
git add services/video-processor/
git commit -m "Add video processor for Railway"
git push origin main
```

2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Select the repo
4. **Service → Settings → Root Directory** → exactly: `services/video-processor`  
   (no leading `/`, no trailing slash)

5. Railway builds from `Dockerfile` (see `railway.toml`)

**Build failed: `no such file or directory .../services`?**  
Railway’s GitHub snapshot does not include `services/`. Use **Option B** below (fastest), or:

1. Push the **full** repo to GitHub (`git push`)
2. Railway → **Settings → Root Directory** → leave **empty** (not `services/video-processor`)
3. Railway → **Settings → Dockerfile Path** → `Dockerfile.video-processor` (at repo root)
4. **Redeploy**

### Option B — Deploy from your Mac (recommended if GitHub build keeps failing)

```bash
npm i -g @railway/cli
cd "/Users/ahmedelhasnaoui/Desktop/Flutter Project/viral_imagetovideo_app"
./scripts/deploy-video-processor-railway.sh
```

First time only:

```bash
railway login
railway link    # pick your "Viral Ai Video" service
```

In Railway → **Variables** → `VIDEO_PROCESSOR_TOKEN` = your secret  
In Railway → **Settings → Root Directory** → **clear it** (empty) when using `railway up`  
Then **Networking → Generate Domain** → set `VIDEO_PROCESSOR_URL` in Supabase.

### 2. Environment variables

In Railway → your service → **Variables**:

| Variable | Value |
|----------|--------|
| `VIDEO_PROCESSOR_TOKEN` | A long random secret (e.g. `openssl rand -hex 32`) |

Railway sets `PORT` automatically — do not override it.

### 3. Public URL

1. **Settings → Networking → Generate Domain**
2. Copy the URL, e.g. `https://cinemorph-video-processor-production.up.railway.app`

### 4. Verify

```bash
curl https://YOUR-RAILWAY-URL/health
```

Expected:

```json
{"ok":true,"service":"cinemorph-video-processor"}
```

### 5. Supabase secrets

```bash
supabase secrets set VIDEO_PROCESSOR_URL=https://YOUR-RAILWAY-URL
supabase secrets set VIDEO_PROCESSOR_TOKEN=same-token-as-railway
```

Redeploy edge functions if needed:

```bash
supabase functions deploy create-generation-job get-generation-job replicate-webhook --no-verify-jwt
```

## Local development (optional)

```bash
docker build -t cinemorph-video-processor .
docker run -p 8080:8080 -e VIDEO_PROCESSOR_TOKEN=dev-token cinemorph-video-processor
curl http://localhost:8080/health
```

Or from repo root:

```bash
VIDEO_PROCESSOR_TOKEN=dev-token ./scripts/start-video-processor.sh
```

## Auth

All `POST` endpoints require:

```
Authorization: Bearer <VIDEO_PROCESSOR_TOKEN>
```

`GET /health` is public (used by Railway health checks).
