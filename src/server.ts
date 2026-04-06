import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import { getTrackInfo, searchTracks, getDeezerPreview } from './spotify';
import { downloadSong, isCached, YT_DLP, FFMPEG_DIR } from './download';

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

// Debug endpoint (temporary)
app.get('/debug', (_req, res) => {
  const { execFileSync } = require('child_process');
  let ytdlpVersion = 'unknown';
  try { ytdlpVersion = execFileSync(YT_DLP, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch (e: any) { ytdlpVersion = `error: ${e.message}`; }
  res.json({ ytdlp: YT_DLP, ytdlpVersion, ffmpeg: FFMPEG_DIR, platform: process.platform });
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

// Check if a song is already downloaded
app.get('/download/:id/status', async (req, res) => {
  res.json({ cached: isCached(req.params.id) });
});

// Trigger download and return when ready (lightweight — no file streaming)
app.get('/download/:id/prepare', async (req, res) => {
  try {
    const trackId = req.params.id;
    const trackInfo = await getTrackInfo(trackId);

    console.log(`Preparing: ${trackInfo.title} - ${trackInfo.artist}`);
    await downloadSong(trackId, trackInfo.title, trackInfo.artist);

    res.json({ ready: true });
  } catch (error: any) {
    console.error('Prepare error:', error.message, error.stack);
    res.status(500).json({ error: error.message || 'Error descargando canción' });
  }
});

// Stream full song file
app.get('/download/:id', async (req, res) => {
  try {
    const trackId = req.params.id;
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