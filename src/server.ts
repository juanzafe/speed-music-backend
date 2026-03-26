import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getTrackInfo, searchTracks, getDeezerPreview } from './spotify';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (_req, res) => {
  res.send('Backend funcionando 🚀');
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

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});