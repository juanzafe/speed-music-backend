import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  // Correct Spotify Token Endpoint
  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({ grant_type: 'client_credentials' }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
      },
    }
  );

  cachedToken = res.data.access_token;
  // Expire 60s early to be safe
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken!;
}

export interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  album: string;
  image: string | null;
  previewUrl: string | null;
  durationMs: number;
}

export async function getTrackInfo(trackId: string): Promise<TrackInfo> {
  const token = await getToken();

  // Correct Get Track Endpoint (Fixed syntax with $)
  const res = await axios.get(
    `https://api.spotify.com/v1/tracks/${trackId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return mapTrack(res.data);
}

export async function searchTracks(query: string, limit = 10): Promise<TrackInfo[]> {
  const token = await getToken();

  // Spotify client_credentials limita a 10 resultados en búsqueda
  const safeLimit = Math.max(1, Math.min(limit || 10, 10));
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${safeLimit}`;

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return res.data.tracks.items.map(mapTrack);
}

function mapTrack(track: any): TrackInfo {
  return {
    id: track.id,
    title: track.name,
    artist: track.artists.map((a: any) => a.name).join(', '),
    album: track.album.name,
    image: track.album.images[0]?.url ?? null,
    previewUrl: track.preview_url ?? null,
    durationMs: track.duration_ms,
  };
}

/**
 * Busca en Deezer un preview de 30s para una canción dada por título y artista.
 * Deezer ofrece previews MP3 gratuitos sin autenticación.
 */
export async function getDeezerPreview(
  title: string,
  artist: string
): Promise<string | null> {
  try {
    const query = `${title} ${artist}`;
    const res = await axios.get('https://api.deezer.com/search', {
      params: { q: query, limit: 1 },
    });

    const track = res.data?.data?.[0];
    return track?.preview || null;
  } catch {
    return null;
  }
}