# YTS + EZTV Stremio Addon

Stream **movies** from YTS and **TV series** from EZTV directly in Stremio via magnet links.

## Catalogs

| Catalog | Source | Description |
|---|---|---|
| 🎬 YTS — Latest | YTS API | Newest movie additions |
| ⭐ YTS — Top Rated | YTS API | IMDb 7+ rated movies |
| 🔥 YTS — Trending | YTS API | Most downloaded movies |
| 🎥 YTS — 4K Ultra HD | YTS API | 2160p quality only |
| 🇮🇳 YTS — Bollywood/Hindi | YTS API | Hindi language movies |
| 🏆 YTS — Recent & Highly Rated | YTS API | New releases with 7+ rating |
| 📺 EZTV — Latest Episodes | EZTV API | Latest TV show episodes |

---

## Local Setup

```bash
npm install
node index.js
```

Then install in Stremio — paste this in Addons → Add from URL:
```
http://localhost:7000/manifest.json
```

---

## 🚀 Deploy Free on Render.com (runs 24/7)

### Step 1 — Push to GitHub
1. Create a free account at https://github.com
2. Create a new repository (e.g. `yts-stremio-addon`)
3. Upload all files from this folder to that repository

### Step 2 — Deploy on Render
1. Go to https://render.com and sign up (free)
2. Click **New** → **Web Service**
3. Connect your GitHub account → select your repository
4. Render auto-detects `render.yaml` — just click **Deploy**
5. Wait ~2 minutes for it to build

### Step 3 — Get your URL
Once deployed, Render gives you a URL like:
```
https://yts-eztv-stremio-addon.onrender.com
```

Install in Stremio using:
```
https://yts-eztv-stremio-addon.onrender.com/manifest.json
```

### ⚠️ Free tier note
Render's free tier **spins down after 15 minutes of inactivity**. The first request after that takes ~30 seconds to wake up. To keep it always-on, upgrade to the $7/month "Starter" plan, or use Railway.app (has a free tier with no sleep).

---

## Alternative: Railway.app

1. Go to https://railway.app → New Project → Deploy from GitHub
2. Connect your repo
3. Set `START_COMMAND = node index.js`
4. Railway gives you a public URL automatically

---

## File Structure

```
├── index.js      — Stremio addon server (all handlers)
├── yts.js        — YTS API wrapper (movies + magnets)
├── eztv.js       — EZTV API wrapper (TV series + magnets)
├── package.json  — Dependencies
├── render.yaml   — Render.com deploy config
└── .gitignore
```
