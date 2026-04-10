import { execFile, execFileSync, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import axios from 'axios';

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const BIN_DIR = path.join(__dirname, '..', 'bin');
const COOKIES_PATH = path.join(__dirname, '..', 'cookies.txt');

// Ensure directories exist
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

/** Write YouTube cookies file from env var (base64-encoded Netscape cookies.txt) */
function setupCookies(): boolean {
  // Check if cookies already on disk
  if (fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 100) {
    console.log('[Cookies] Using existing cookies.txt');
    return true;
  }
  const b64 = process.env.YOUTUBE_COOKIES;
  if (b64) {
    try {
      const content = Buffer.from(b64, 'base64').toString('utf8');
      fs.writeFileSync(COOKIES_PATH, content);
      console.log(`[Cookies] Wrote cookies.txt (${content.length} bytes)`);
      return true;
    } catch (e: any) {
      console.error('[Cookies] Failed to decode YOUTUBE_COOKIES:', e.message);
    }
  }
  return false;
}

/** Update cookies file from raw content */
export function updateCookies(content: string): void {
  fs.writeFileSync(COOKIES_PATH, content);
  console.log(`[Cookies] Updated cookies.txt (${content.length} bytes)`);
}

/** Check if cookies are available */
export function hasCookies(): boolean {
  return fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 100;
}

const _hasCookies = setupCookies();

/** On Windows, find local winget-installed yt-dlp */
function findYtDlpWindows(): string {
  const localAppData = process.env.LOCALAPPDATA || '';
  const linksPath = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe');
  if (fs.existsSync(linksPath)) return linksPath;
  const packagesDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(packagesDir)) {
    const dirs = fs.readdirSync(packagesDir).filter(d => d.startsWith('yt-dlp.yt-dlp'));
    for (const dir of dirs) {
      const exe = path.join(packagesDir, dir, 'yt-dlp.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return 'yt-dlp';
}

/** On Windows, find local winget-installed ffmpeg */
function findFfmpegDirWindows(): string | undefined {
  const localAppData = process.env.LOCALAPPDATA || '';
  const packagesDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(packagesDir)) {
    const dirs = fs.readdirSync(packagesDir).filter(d => d.startsWith('yt-dlp.FFmpeg'));
    for (const dir of dirs) {
      const binDir = path.join(packagesDir, dir);
      const nested = fs.readdirSync(binDir).find(f => f.startsWith('ffmpeg'));
      if (nested) {
        const bin = path.join(binDir, nested, 'bin');
        if (fs.existsSync(path.join(bin, 'ffmpeg.exe'))) return bin;
      }
      if (fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) return binDir;
    }
  }
  return undefined;
}

let _ytdlp: string | null = null;
let _ffmpegDir: string | undefined = undefined;
let _binariesReady = false;

/**
 * Ensure yt-dlp and ffmpeg are available. Downloads them on first call (Linux only).
 * On Windows, finds locally installed binaries.
 */
async function ensureBinaries(): Promise<{ ytdlp: string; ffmpegDir?: string }> {
  if (_binariesReady && _ytdlp) return { ytdlp: _ytdlp, ffmpegDir: _ffmpegDir };

  if (process.platform === 'win32') {
    _ytdlp = findYtDlpWindows();
    _ffmpegDir = findFfmpegDirWindows();
    _binariesReady = true;
    console.log('yt-dlp (win):', _ytdlp);
    console.log('ffmpeg dir (win):', _ffmpegDir);
    return { ytdlp: _ytdlp, ffmpegDir: _ffmpegDir };
  }

  // Linux: download standalone binaries (always update yt-dlp on startup)
  const ytdlpPath = path.join(BIN_DIR, 'yt-dlp');
  // Always re-download yt-dlp to ensure latest version (YouTube frequently breaks older versions)
  console.log('Downloading latest yt-dlp_linux...');
  try {
    execSync(
      `curl -L --retry 3 --max-time 120 -o "${ytdlpPath}" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"`,
      { stdio: 'inherit', timeout: 150_000 }
    );
    fs.chmodSync(ytdlpPath, 0o755);
    console.log('yt-dlp updated OK');
  } catch (e: any) {
    console.warn('yt-dlp download failed, using existing if available:', e.message);
    if (!fs.existsSync(ytdlpPath)) throw new Error('No yt-dlp binary available');
  }

  const ffmpegPath = path.join(BIN_DIR, 'ffmpeg');
  if (!fs.existsSync(ffmpegPath)) {
    console.log('Downloading ffmpeg static...');
    const tarPath = path.join(BIN_DIR, 'ffmpeg.tar.xz');
    execSync(
      `curl -L --retry 3 --max-time 300 -o "${tarPath}" "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"`,
      { stdio: 'inherit', timeout: 360_000 }
    );
    console.log('Extracting ffmpeg...');
    // Extract to temp, then move just the ffmpeg binary
    execSync(
      `cd "${BIN_DIR}" && tar -xJf ffmpeg.tar.xz && cp ffmpeg-*-amd64-static/ffmpeg . && rm -rf ffmpeg-*-amd64-static ffmpeg.tar.xz`,
      { stdio: 'inherit', timeout: 120_000 }
    );
    fs.chmodSync(ffmpegPath, 0o755);
    console.log('ffmpeg extracted OK');
  }

  _ytdlp = ytdlpPath;
  _ffmpegDir = fs.existsSync(ffmpegPath) ? BIN_DIR : undefined;
  _binariesReady = true;

  // Symlink node into bin/ so yt-dlp can find it for JS challenges
  const nodeLink = path.join(BIN_DIR, 'node');
  if (!fs.existsSync(nodeLink)) {
    try {
      const nodePath = execSync('which node', { encoding: 'utf8', timeout: 5_000 }).trim();
      if (nodePath && fs.existsSync(nodePath)) {
        fs.symlinkSync(nodePath, nodeLink);
        console.log('Symlinked node:', nodePath, '->', nodeLink);
      }
    } catch (e: any) { console.warn('Could not symlink node:', e.message); }
  }

  // Verify
  try {
    const v = execFileSync(ytdlpPath, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    console.log('yt-dlp version:', v);
  } catch (e: any) { console.error('yt-dlp verify failed:', e.message); }

  return { ytdlp: _ytdlp, ffmpegDir: _ffmpegDir };
}

/** Expose for debug endpoint */
export function getBinInfo() {
  return {
    ytdlp: _ytdlp,
    ffmpegDir: _ffmpegDir,
    binariesReady: _binariesReady,
    binDir: BIN_DIR,
    binExists: fs.existsSync(BIN_DIR),
    binContents: fs.existsSync(BIN_DIR) ? fs.readdirSync(BIN_DIR) : [],
    platform: process.platform,
  };
}

export { ensureBinaries };

/**
 * Run yt-dlp with given search prefix and return output path if successful.
 */
function runYtDlp(
  ytdlp: string,
  searchPrefix: string,
  query: string,
  outputPath: string,
  ffmpegDir?: string,
  extraArgs: string[] = [],
  timeoutMs: number = 45_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      `${searchPrefix}${query}`,
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '--no-playlist',
      '--max-downloads', '1',
      '--output', outputPath.replace('.mp3', '.%(ext)s'),
      '--no-warnings',
      ...extraArgs,
    ];

    if (ffmpegDir) {
      args.push('--ffmpeg-location', ffmpegDir);
    }

    // Use cookies if available (bypasses "Sign in to confirm you're not a bot")
    if (hasCookies()) {
      args.push('--cookies', COOKIES_PATH);
    }

    console.log(`Running: ${ytdlp} ${args.join(' ')}`);

    const env = { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH}` };

    execFile(ytdlp, args, { timeout: timeoutMs, env }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[${searchPrefix}] stderr:`, stderr?.substring(0, 500));
        console.error(`[${searchPrefix}] error:`, error.message);
        // Delete partial file left by failed conversion
        if (fs.existsSync(outputPath)) {
          console.warn(`[${searchPrefix}] Removing partial file: ${outputPath}`);
          fs.unlinkSync(outputPath);
        }
        reject(new Error(stderr || error.message));
        return;
      }

      if (fs.existsSync(outputPath)) {
        resolve(outputPath);
        return;
      }

      reject(new Error('File not found after download'));
    });
  });
}

/**
 * Downloads a full song using yt-dlp.
 * Strategy: SoundCloud first (works from datacenter), then YouTube, then proxies.
 */
export async function downloadSong(
  trackId: string,
  title: string,
  artist: string
): Promise<string> {
  const outputPath = path.join(DOWNLOADS_DIR, `${trackId}.mp3`);

  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  const { ytdlp, ffmpegDir } = await ensureBinaries();
  const query = `${title} ${artist}`;

  // Strategy 1: SoundCloud (works from datacenter IPs, no bot detection)
  try {
    console.log(`[SoundCloud] Trying: ${query}`);
    return await runYtDlp(ytdlp, 'scsearch1:', query, outputPath, ffmpegDir, [], 90_000);
  } catch (scErr: any) {
    console.warn('[SoundCloud] failed:', scErr.message?.substring(0, 150));
  }

  // Strategy 2: YouTube with cookies (if available)
  const fastClients = ['default,mediaconnect', 'ios', 'android_vr'];
  for (const client of fastClients) {
    try {
      console.log(`[yt-dlp] Trying player_client=${client}...`);
      return await runYtDlp(ytdlp, 'ytsearch1:', query, outputPath, ffmpegDir, [
        '--extractor-args', `youtube:player_client=${client}`,
      ]);
    } catch (err: any) {
      console.warn(`[yt-dlp] ${client} failed:`, err.message?.substring(0, 120));
    }
  }

  // Strategy 3: Invidious (proxied YouTube)
  try {
    return await downloadViaInvidious(query, outputPath, ffmpegDir);
  } catch (invErr: any) {
    console.warn('Invidious failed:', invErr.message?.substring(0, 150));
  }

  // Strategy 4: Piped (proxied YouTube)
  try {
    return await downloadViaPiped(query, outputPath, ffmpegDir);
  } catch (pipedErr: any) {
    console.warn('Piped failed:', pipedErr.message?.substring(0, 150));
  }

  throw new Error('No se pudo descargar la canción de ninguna fuente');
}

// ── Invidious API (YouTube proxy) ──────────────────────────

const FALLBACK_INVIDIOUS_INSTANCES = [
  'https://inv.thepixora.com',
  'https://invidious.materialio.us',
  'https://yewtu.be',
  'https://inv.tux.pizza',
  'https://invidious.privacyredirect.com',
  'https://iv.ggtyler.dev',
  'https://invidious.io.lol',
  'https://invidious.lunar.icu',
];

let _cachedInvidiousInstances: string[] | null = null;
let _invidiousCacheTime = 0;
const INVIDIOUS_CACHE_TTL = 30 * 60_000; // 30 minutes

/** Fetch working Invidious API instances dynamically, with fallback to hardcoded list */
async function getInvidiousInstances(): Promise<string[]> {
  if (_cachedInvidiousInstances && Date.now() - _invidiousCacheTime < INVIDIOUS_CACHE_TTL) {
    return _cachedInvidiousInstances;
  }
  try {
    const res = await axios.get('https://api.invidious.io/instances.json', { timeout: 10_000 });
    const all: string[] = res.data
      .filter((entry: any) => entry[1]?.type === 'https' && entry[1]?.api)
      .map((entry: any) => 'https://' + entry[0]);
    if (all.length > 0) {
      _cachedInvidiousInstances = all;
      _invidiousCacheTime = Date.now();
      console.log(`[Invidious] Loaded ${all.length} instances`);
      return all;
    }
  } catch (e: any) {
    console.warn('[Invidious] Failed to fetch instances list:', e.message?.substring(0, 100));
  }
  return FALLBACK_INVIDIOUS_INSTANCES;
}

/** Search for a videoId via Invidious search API */
async function searchInvidiousVideoId(query: string): Promise<string | null> {
  const instances = await getInvidiousInstances();
  for (const instance of instances.slice(0, 5)) {
    try {
      const searchRes = await axios.get(`${instance}/api/v1/search`, {
        params: { q: query, type: 'video' },
        timeout: 12_000,
      });
      const items = searchRes.data;
      if (Array.isArray(items) && items.length > 0 && items[0].videoId) {
        return items[0].videoId;
      }
    } catch {}
  }
  return null;
}

/** Get a proxied audio stream URL from Invidious for a given videoId.
 *  Uses the /latest_version endpoint with local=true which proxies through the instance.
 *  Returns the URL without verifying (to avoid consuming rate limit). */
async function getInvidiousAudioStream(
  videoId: string,
  instances?: string[]
): Promise<{ url: string; mimeType: string; itag: number } | null> {
  const invInstances = instances || (await getInvidiousInstances());
  // Return URL for best instance — itag 140 = m4a 128kbps (widely supported)
  for (const instance of invInstances.slice(0, 5)) {
    const url = `${instance}/latest_version?id=${videoId}&itag=140&local=true`;
    console.log(`[Invidious] Built stream URL: ${instance} itag=140`);
    return { url, mimeType: 'audio/mp4', itag: 140 };
  }
  return null;
}

/**
 * Download audio via Invidious API (YouTube proxy with local=true).
 */
async function downloadViaInvidious(
  query: string,
  outputPath: string,
  ffmpegDir?: string
): Promise<string> {
  const instances = await getInvidiousInstances();

  // Search for videoId
  let videoId: string | null = null;
  for (const instance of instances.slice(0, 5)) {
    try {
      const searchRes = await axios.get(`${instance}/api/v1/search`, {
        params: { q: query, type: 'video' },
        timeout: 12_000,
      });
      const items = searchRes.data;
      if (Array.isArray(items) && items.length > 0 && items[0].videoId) {
        videoId = items[0].videoId;
        console.log(`[Invidious] Found: ${items[0].title} (${videoId})`);
        break;
      }
    } catch (e: any) {
      console.warn(`[Invidious] Search on ${instance} failed: ${e.message?.substring(0, 100)}`);
    }
  }

  if (!videoId) throw new Error('Invidious search: no video found');

  // Get audio stream via latest_version with local proxy
  const stream = await getInvidiousAudioStream(videoId, instances);
  if (!stream) throw new Error('Invidious: no audio stream available');

  console.log(`[Invidious] Downloading: ${stream.mimeType} itag=${stream.itag}`);

  // Try ffmpeg conversion first
  const ffmpegBin = ffmpegDir
    ? path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    : 'ffmpeg';

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegBin,
        ['-y', '-i', stream.url, '-vn', '-acodec', 'libmp3lame', '-ab', '192k', outputPath],
        { timeout: 120_000 },
        (error, _stdout, stderr) => {
          if (error) {
            console.error('[Invidious] ffmpeg error:', stderr?.substring(0, 300));
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  } catch {
    // ffmpeg failed — download raw audio directly
    console.log('[Invidious] ffmpeg failed, downloading raw...');
    const audioRes = await axios.get(stream.url, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxRedirects: 5,
      maxContentLength: 50 * 1024 * 1024,
    });
    const rawPath = outputPath.replace('.mp3', stream.mimeType.includes('mp4') ? '.m4a' : '.webm');
    fs.writeFileSync(rawPath, audioRes.data);
    if (rawPath !== outputPath) {
      fs.renameSync(rawPath, outputPath);
    }
  }

  // Verify file size
  if (fs.existsSync(outputPath)) {
    const size = fs.statSync(outputPath).size;
    if (size > 500_000) {
      console.log(`[Invidious] Success: ${(size / 1_048_576).toFixed(1)} MB`);
      return outputPath;
    }
    console.warn(`[Invidious] File too small (${size} bytes), discarding`);
    fs.unlinkSync(outputPath);
  }

  throw new Error('Invidious download failed');
}

// ── Piped API (YouTube proxy) ──────────────────────────

const FALLBACK_PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.private.coffee',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.darkness.services',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.drgns.space',
  'https://pipedapi.ducks.party',
  'https://pipedapi.orangenet.cc',
];

let _cachedPipedInstances: string[] | null = null;
let _pipedCacheTime = 0;
const PIPED_CACHE_TTL = 30 * 60_000; // 30 minutes

/** Fetch working Piped API instances dynamically, with fallback to hardcoded list */
async function getPipedInstances(): Promise<string[]> {
  if (_cachedPipedInstances && Date.now() - _pipedCacheTime < PIPED_CACHE_TTL) {
    return _cachedPipedInstances;
  }
  try {
    const res = await axios.get('https://piped-instances.kavin.rocks/', { timeout: 10_000 });
    const all: string[] = res.data
      .filter((i: any) => i.api_url && i.uptime_24h >= 90)
      .sort((a: any, b: any) => (b.uptime_7d || 0) - (a.uptime_7d || 0))
      .map((i: any) => i.api_url);
    if (all.length > 0) {
      _cachedPipedInstances = all;
      _pipedCacheTime = Date.now();
      console.log(`[Piped] Loaded ${all.length} instances`);
      return all;
    }
  } catch (e: any) {
    console.warn('[Piped] Failed to fetch instances list:', e.message?.substring(0, 100));
  }
  return FALLBACK_PIPED_INSTANCES;
}

/** Find a videoId via Piped search (works from datacenter IPs) */
async function searchPipedVideoId(query: string): Promise<string | null> {
  const instances = await getPipedInstances();
  for (const instance of instances.slice(0, 5)) {
    try {
      const searchRes = await axios.get(`${instance}/search`, {
        params: { q: query, filter: 'music_songs' },
        timeout: 12_000,
      });
      const items = searchRes.data?.items;
      if (items?.length) {
        const url: string = items[0].url || '';
        const vid = url.replace('/watch?v=', '').split('&')[0];
        if (vid) return vid;
      }
    } catch {}
  }
  return null;
}

/** Get audio stream URL from Piped for a given videoId */
async function getPipedAudioStream(
  videoId: string,
  instances?: string[]
): Promise<{ url: string; mimeType: string; bitrate: number } | null> {
  const pipedInstances = instances || (await getPipedInstances());
  for (const instance of pipedInstances.slice(0, 6)) {
    try {
      const streamRes = await axios.get(`${instance}/streams/${videoId}`, {
        timeout: 15_000,
      });
      const audioStreams: any[] = streamRes.data?.audioStreams || [];
      if (!audioStreams.length) continue;

      // Prefer mp4 audio (better ffmpeg compatibility), then any audio
      const valid = audioStreams.filter((s: any) => s.url && s.mimeType?.startsWith('audio/'));
      const mp4Sorted = valid
        .filter((s: any) => s.mimeType?.includes('mp4'))
        .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
      const allSorted = valid.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
      const best = mp4Sorted[0] || allSorted[0];

      if (best?.url) {
        return { url: best.url, mimeType: best.mimeType, bitrate: best.bitrate || 0 };
      }
    } catch (e: any) {
      console.warn(`[Piped] streams from ${instance} failed: ${e.message?.substring(0, 100)}`);
    }
  }
  return null;
}

/**
 * Download audio via Piped API (YouTube proxy).
 * Piped proxies the YouTube content through their servers,
 * avoiding datacenter IP bot detection.
 */
async function downloadViaPiped(
  query: string,
  outputPath: string,
  ffmpegDir?: string
): Promise<string> {
  const instances = await getPipedInstances();

  // Search for videoId
  let videoId: string | null = null;
  for (const instance of instances.slice(0, 5)) {
    try {
      const searchRes = await axios.get(`${instance}/search`, {
        params: { q: query, filter: 'music_songs' },
        timeout: 12_000,
      });
      const items = searchRes.data?.items;
      if (items?.length) {
        const url: string = items[0].url || '';
        videoId = url.replace('/watch?v=', '').split('&')[0];
        if (videoId) {
          console.log(`[Piped] Found: ${items[0].title} (${videoId})`);
          break;
        }
      }
    } catch (e: any) {
      console.warn(`[Piped] Search on ${instance} failed: ${e.message?.substring(0, 100)}`);
    }
  }

  if (!videoId) throw new Error('Piped search: no video found');

  // Get audio stream URL (try multiple instances for streams)
  const stream = await getPipedAudioStream(videoId, instances);
  if (!stream) throw new Error('Piped: no audio streams found');

  console.log(`[Piped] Stream: ${stream.mimeType} ${stream.bitrate}bps`);

  // Try ffmpeg conversion first, then direct download as fallback
  const ffmpegBin = ffmpegDir
    ? path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    : 'ffmpeg';

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegBin,
        ['-y', '-i', stream.url, '-vn', '-acodec', 'libmp3lame', '-ab', '192k', outputPath],
        { timeout: 120_000 },
        (error, _stdout, stderr) => {
          if (error) {
            console.error('[Piped] ffmpeg error:', stderr?.substring(0, 300));
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  } catch {
    // ffmpeg failed — download raw audio directly
    console.log('[Piped] ffmpeg failed, downloading raw audio...');
    const audioRes = await axios.get(stream.url, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: 50 * 1024 * 1024,
    });
    const rawPath = outputPath.replace('.mp3', stream.mimeType.includes('mp4') ? '.m4a' : '.webm');
    fs.writeFileSync(rawPath, audioRes.data);
    // Rename to .mp3 so it's found by isCached
    if (rawPath !== outputPath) {
      fs.renameSync(rawPath, outputPath);
    }
  }

  // Verify file is a real song (not a tiny preview)
  if (fs.existsSync(outputPath)) {
    const size = fs.statSync(outputPath).size;
    if (size > 500_000) {
      console.log(`[Piped] Success: ${(size / 1_048_576).toFixed(1)} MB`);
      return outputPath;
    }
    console.warn(`[Piped] File too small (${size} bytes), discarding`);
    fs.unlinkSync(outputPath);
  }

  throw new Error('Piped download failed from all instances');
}

export { searchPipedVideoId, getPipedAudioStream, getPipedInstances, searchInvidiousVideoId, getInvidiousAudioStream, getInvidiousInstances };

/** Check if a song is already cached */
export function isCached(trackId: string): boolean {
  return fs.existsSync(path.join(DOWNLOADS_DIR, `${trackId}.mp3`));
}
