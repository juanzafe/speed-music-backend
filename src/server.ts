import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { getTrackInfo, searchTracks, getDeezerPreview } from './spotify';
import { downloadSong, isCached, ensureBinaries, getBinInfo, searchPipedVideoId, getPipedAudioStream, getPipedInstances } from './download';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8081';
const SPOTIFY_REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

// Health check
app.get('/', (_req, res) => {
  res.send('Backend funcionando 🚀');
});

// Test download endpoint (temporary) - tries multiple methods
app.get('/test-download', async (_req, res) => {
  const results: Record<string, any> = {};
  const { ytdlp } = await ensureBinaries();
  const info = getBinInfo();
  const env = { ...process.env, PATH: `${info.binDir}:${process.env.PATH}` };
  const { execFileSync: efs } = require('child_process');

  // Test multiple YouTube player clients
  const clients = ['ios', 'mweb', 'tv_embedded', 'web_music', 'android_music', 'web_creator'];
  for (const client of clients) {
    try {
      const out = efs(ytdlp, [
        'ytsearch1:Bohemian Rhapsody Queen', '--dump-json', '--no-warnings',
        '--extractor-args', `youtube:player_client=${client}`,
      ], { timeout: 30_000, env, encoding: 'utf8' });
      const json = JSON.parse(out);
      results[`yt_${client}`] = { ok: true, title: json.title, duration: json.duration, formats: json.formats?.length };
    } catch (e: any) {
      results[`yt_${client}`] = { ok: false, error: (e.stderr || e.message)?.substring(0, 300) };
    }
  }

  // Test Invidious dynamic instances
  try {
    const instRes = await axios.get('https://api.invidious.io/instances.json?sort_by=type,health', { timeout: 10_000 });
    const instances = instRes.data
      .filter((i: any) => i[1]?.type === 'https' && i[1]?.api === true)
      .slice(0, 5)
      .map((i: any) => i[1].uri);
    results.invidious_instances = instances;
    for (const inst of instances) {
      try {
        const sr = await axios.get(`${inst}/api/v1/search`, { params: { q: 'Bohemian Rhapsody', type: 'video' }, timeout: 10_000 });
        if (sr.data?.[0]?.videoId) {
          const vid = sr.data[0].videoId;
          const vr = await axios.get(`${inst}/api/v1/videos/${vid}`, { timeout: 10_000 });
          const audio = vr.data?.adaptiveFormats?.filter((f: any) => f.type?.startsWith('audio/'));
          results[`inv_${new URL(inst).hostname}`] = { ok: true, videoId: vid, audioFormats: audio?.length };
        }
      } catch (e: any) { results[`inv_${new URL(inst).hostname}`] = { ok: false, error: e.message?.substring(0, 100) }; }
    }
  } catch (e: any) { results.invidious_api = { ok: false, error: e.message?.substring(0, 100) }; }

  // Test Cobalt API
  try {
    const cr = await axios.post('https://api.cobalt.tools/', {
      url: 'https://www.youtube.com/watch?v=fJ9rUzIMcZQ', downloadMode: 'audio', audioFormat: 'mp3'
    }, { headers: { Accept: 'application/json' }, timeout: 15_000 });
    results.cobalt = { ok: true, status: cr.data?.status, url: cr.data?.url?.substring(0, 100) };
  } catch (e: any) { results.cobalt = { ok: false, error: e.message?.substring(0, 100) }; }

  res.json(results);
});

// Debug endpoint (temporary)
app.get('/debug', async (_req, res) => {
  try {
    const bins = await ensureBinaries();
    const info = getBinInfo();
    let ytdlpVersion = 'unknown';
    try {
      const { execFileSync } = require('child_process');
      ytdlpVersion = execFileSync(bins.ytdlp, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
    } catch (e: any) { ytdlpVersion = `error: ${e.message}`; }
    res.json({ ...info, ytdlpVersion });
  } catch (e: any) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// Buscar canciones por nombre
app.get('/search', async (req, res) => {
  try {
    const q = req.query.q as string | undefined;
    if (!q || !q.trim()) {
      res.status(400).json({ error: 'Parámetro "q" requerido' });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 10, 10);
    const results = await searchTracks(q.trim(), limit);

    // Para las canciones sin preview de Spotify, buscar en Deezer
    const enriched = await Promise.all(
      results.map(async (track) => {
        if (!track.previewUrl) {
          track.previewUrl = await getDeezerPreview(track.title, track.artist);
        }
        return track;
      })
    );

    res.json(enriched);
  } catch (error: any) {
    const msg = error?.response?.data?.error?.message || error?.message || 'Unknown';
    console.error('Search error:', msg);
    res.status(500).json({ error: 'Error buscando canciones' });
  }
});

// Obtener info de una canción por ID de Spotify
app.get('/song/:id', async (req, res) => {
  try {
    const trackId = req.params.id;
    const trackInfo = await getTrackInfo(trackId);

    // Si Spotify no da preview, buscar en Deezer
    if (!trackInfo.previewUrl) {
      trackInfo.previewUrl = await getDeezerPreview(trackInfo.title, trackInfo.artist);
    }

    res.json(trackInfo);
  } catch (error: any) {
    console.error('Song error:', error?.response?.data?.error?.message || error?.message);
    res.status(500).json({ error: 'Error obteniendo canción' });
  }
});

// ──────────────────────────────────────
// Full song download via yt-dlp
// ──────────────────────────────────────

// Track in-progress downloads: trackId -> { status, error? }
const downloadJobs = new Map<string, { status: 'downloading' | 'ready' | 'error'; error?: string }>();

// Check download status (includes file size when ready)
app.get('/download/:id/status', async (req, res) => {
  const trackId = req.params.id;
  // Check active jobs FIRST — file may exist on disk but still be written by ffmpeg/yt-dlp
  const job = downloadJobs.get(trackId);
  if (job && job.status === 'downloading') {
    res.json({ status: 'downloading' });
    return;
  }
  if (isCached(trackId)) {
    const size = fs.statSync(path.join(__dirname, '..', 'downloads', `${trackId}.mp3`)).size;
    res.json({ status: 'ready', size });
    return;
  }
  if (job) {
    res.json({ status: job.status, error: job.error });
    return;
  }
  res.json({ status: 'none' });
});

// Cache for video IDs to avoid repeated searches
const videoIdCache = new Map<string, string>();

// Get YouTube video ID for client-side Piped download
app.get('/download/:id/video-id', async (req, res) => {
  try {
    const trackId = req.params.id;

    // Check cache first
    if (videoIdCache.has(trackId)) {
      const trackInfo = await getTrackInfo(trackId);
      res.json({ videoId: videoIdCache.get(trackId), title: trackInfo.title, artist: trackInfo.artist });
      return;
    }

    const trackInfo = await getTrackInfo(trackId);
    const query = `${trackInfo.title} ${trackInfo.artist}`;

    let videoId = '';

    // Try Piped search with dynamic instances
    videoId = (await searchPipedVideoId(query)) || '';

    // Fallback to yt-dlp search
    if (!videoId) {
      try {
        const { ytdlp } = await ensureBinaries();
        const { execFileSync: efs } = require('child_process');
        videoId = efs(ytdlp, [
          '--flat-playlist', '--print', 'id', `ytsearch1:${query}`, '--no-warnings',
        ], { timeout: 20_000, encoding: 'utf8' }).trim();
      } catch (e: any) {
        console.warn('yt-dlp search failed:', e.message?.substring(0, 100));
      }
    }

    if (!videoId) {
      res.status(404).json({ error: 'No video found' });
      return;
    }

    videoIdCache.set(trackId, videoId);
    res.json({ videoId, title: trackInfo.title, artist: trackInfo.artist });
  } catch (error: any) {
    console.error('Video ID error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Proxy audio stream from Piped → client (avoids CORS issues)
app.get('/download/:id/stream', async (req, res) => {
  try {
    const trackId = req.params.id;

    // Get video ID (cache → Piped search → yt-dlp search)
    let videoId = videoIdCache.get(trackId);
    if (!videoId) {
      const trackInfo = await getTrackInfo(trackId);
      const query = `${trackInfo.title} ${trackInfo.artist}`;
      videoId = (await searchPipedVideoId(query)) || undefined;

      // Fallback: yt-dlp search
      if (!videoId) {
        try {
          const { ytdlp } = await ensureBinaries();
          const { execFileSync: efs } = require('child_process');
          videoId = efs(ytdlp, [
            '--flat-playlist', '--print', 'id', `ytsearch1:${query}`, '--no-warnings',
          ], { timeout: 20_000, encoding: 'utf8' }).trim();
        } catch {}
      }

      if (videoId) videoIdCache.set(trackId, videoId);
    }

    if (!videoId) {
      res.status(404).json({ error: 'No video found' });
      return;
    }

    // Get best audio stream URL from Piped (tries multiple instances)
    const stream = await getPipedAudioStream(videoId);
    if (!stream) {
      res.status(502).json({ error: 'No audio stream available' });
      return;
    }

    console.log(`[Stream proxy] Fetching audio: ${stream.mimeType} ${stream.bitrate}bps`);
    console.log(`[Stream proxy] URL host: ${new URL(stream.url).hostname}`);

    // Use Node's native https to avoid axios header issues with Piped proxy
    const https = require('https');
    const http = require('http');
    const streamUrl = new URL(stream.url);
    const transport = streamUrl.protocol === 'https:' ? https : http;

    const proxyReq = transport.get(stream.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
      },
      timeout: 120_000,
    }, (proxyRes: any) => {
      if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
        console.error(`[Stream proxy] Upstream returned ${proxyRes.statusCode}`);
        if (!res.headersSent) {
          res.status(502).json({ error: `Upstream returned ${proxyRes.statusCode}` });
        }
        return;
      }

      const contentType = stream.mimeType.includes('mp4') ? 'audio/mp4' : 'audio/webm';
      res.setHeader('Content-Type', contentType);
      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err: any) => {
      console.error('[Stream proxy] Request error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error streaming audio' });
      }
    });
  } catch (error: any) {
    console.error('Stream proxy error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error streaming audio' });
    }
  }
});

// Trigger download in background — returns immediately
app.get('/download/:id/prepare', async (req, res) => {
  try {
    const trackId = req.params.id;

    // Already cached
    if (isCached(trackId)) {
      res.json({ status: 'ready' });
      return;
    }

    // Already in progress
    const existing = downloadJobs.get(trackId);
    if (existing && existing.status === 'downloading') {
      res.json({ status: 'downloading' });
      return;
    }

    const trackInfo = await getTrackInfo(trackId);
    console.log(`Preparing (async): ${trackInfo.title} - ${trackInfo.artist}`);

    // Mark as downloading and kick off in background
    downloadJobs.set(trackId, { status: 'downloading' });
    downloadSong(trackId, trackInfo.title, trackInfo.artist)
      .then(() => {
        downloadJobs.set(trackId, { status: 'ready' });
        console.log(`Ready: ${trackInfo.title}`);
      })
      .catch((err) => {
        downloadJobs.set(trackId, { status: 'error', error: err.message });
        console.error(`Download failed: ${trackInfo.title}`, err.message);
      });

    res.json({ status: 'downloading' });
  } catch (error: any) {
    console.error('Prepare error:', error.message);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Stream full song file
app.get('/download/:id', async (req, res) => {
  try {
    const trackId = req.params.id;

    // Don't serve file while background download is still writing it
    const job = downloadJobs.get(trackId);
    if (job && job.status === 'downloading') {
      res.status(409).json({ error: 'Download still in progress' });
      return;
    }

    const trackInfo = await getTrackInfo(trackId);

    console.log(`Downloading: ${trackInfo.title} - ${trackInfo.artist}`);
    const filePath = await downloadSong(trackId, trackInfo.title, trackInfo.artist);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.sendFile(path.resolve(filePath));
  } catch (error: any) {
    console.error('Download error:', error.message);
    res.status(500).json({ error: 'Error descargando canción' });
  }
});

// ──────────────────────────────────────
// Spotify OAuth
// ──────────────────────────────────────

app.get('/auth/login', (_req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID!,
    scope: 'streaming user-read-email user-read-private',
    redirect_uri: SPOTIFY_REDIRECT_URI,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;

  if (error || !code) {
    res.redirect(`${FRONTEND_URL}#auth_error=${error || 'no_code'}`);
    return;
  }

  try {
    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' +
            Buffer.from(
              process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
            ).toString('base64'),
        },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const fragment = new URLSearchParams({
      access_token,
      refresh_token,
      expires_in: String(expires_in),
    });
    res.redirect(`${FRONTEND_URL}#${fragment}`);
  } catch (err: any) {
    const spotifyError = err?.response?.data;
    console.error('OAuth callback error STATUS:', err?.response?.status);
    console.error('OAuth callback error DATA:', JSON.stringify(spotifyError, null, 2));
    console.error('OAuth callback error MSG:', err.message);
    console.error('Redirect URI used:', SPOTIFY_REDIRECT_URI);
    const errorDetail = spotifyError?.error_description || spotifyError?.error || 'token_exchange_failed';
    res.redirect(`${FRONTEND_URL}#auth_error=${encodeURIComponent(errorDetail)}`);
  }
});

app.post('/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    res.status(400).json({ error: 'refresh_token requerido' });
    return;
  }

  try {
    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' +
            Buffer.from(
              process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
            ).toString('base64'),
        },
      }
    );

    res.json(tokenRes.data);
  } catch (err: any) {
    console.error('Refresh error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Error refrescando token' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});