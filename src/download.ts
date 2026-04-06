import { execFile, execFileSync, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import axios from 'axios';

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const BIN_DIR = path.join(__dirname, '..', 'bin');

// Ensure directories exist
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

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

  // Linux: download standalone binaries
  const ytdlpPath = path.join(BIN_DIR, 'yt-dlp');
  if (!fs.existsSync(ytdlpPath)) {
    console.log('Downloading yt-dlp_linux standalone...');
    execSync(
      `curl -L --retry 3 --max-time 120 -o "${ytdlpPath}" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"`,
      { stdio: 'inherit', timeout: 150_000 }
    );
    fs.chmodSync(ytdlpPath, 0o755);
    console.log('yt-dlp downloaded OK');
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
  extraArgs: string[] = []
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

    console.log(`Running: ${ytdlp} ${args.join(' ')}`);

    const env = { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH}` };

    execFile(ytdlp, args, { timeout: 120_000, env }, (error, stdout, stderr) => {
      if (fs.existsSync(outputPath)) {
        resolve(outputPath);
        return;
      }

      if (error) {
        console.error(`[${searchPrefix}] stderr:`, stderr?.substring(0, 500));
        console.error(`[${searchPrefix}] error:`, error.message);
        reject(new Error(stderr || error.message));
        return;
      }

      reject(new Error('File not found after download'));
    });
  });
}

/**
 * Downloads a full song using yt-dlp.
 * Tries YouTube first, falls back to SoundCloud if YouTube blocks (bot detection).
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

  // Try YouTube via yt-dlp (works from residential IPs)
  try {
    return await runYtDlp(ytdlp, 'ytsearch1:', query, outputPath, ffmpegDir, [
      '--extractor-args', 'youtube:player_client=web',
    ]);
  } catch (ytErr: any) {
    console.warn('YouTube yt-dlp failed, trying Piped API...', ytErr.message?.substring(0, 200));
  }

  // Fallback: Piped API (proxies YouTube, works from datacenter IPs)
  try {
    return await downloadViaPiped(query, outputPath, ffmpegDir);
  } catch (pipedErr: any) {
    console.warn('Piped failed:', pipedErr.message?.substring(0, 200));
  }

  // Last resort: SoundCloud (might give short previews)
  try {
    return await runYtDlp(ytdlp, 'scsearch1:', query, outputPath, ffmpegDir);
  } catch (scErr: any) {
    console.error('All sources failed:', scErr.message?.substring(0, 200));
    throw new Error('No se pudo descargar la canción de ninguna fuente');
  }
}

// ── Piped API (YouTube proxy) ──────────────────────────

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.privacydev.net',
];

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
  for (const instance of PIPED_INSTANCES) {
    try {
      console.log(`[Piped] Trying ${instance}...`);

      // Search for the video
      const searchRes = await axios.get(`${instance}/search`, {
        params: { q: query, filter: 'music_songs' },
        timeout: 15_000,
      });

      const items = searchRes.data?.items;
      if (!items?.length) {
        console.warn(`[Piped] No results from ${instance}`);
        continue;
      }

      // Get video ID from first result
      const videoUrl: string = items[0].url || '';
      const videoId = videoUrl.split('v=')[1] || videoUrl.replace('/watch?v=', '');
      if (!videoId) continue;

      console.log(`[Piped] Found: ${items[0].title} (${videoId})`);

      // Get audio streams
      const streamRes = await axios.get(`${instance}/streams/${videoId}`, {
        timeout: 15_000,
      });

      const audioStreams: any[] = streamRes.data?.audioStreams || [];
      if (!audioStreams.length) {
        console.warn(`[Piped] No audio streams for ${videoId}`);
        continue;
      }

      // Pick best audio stream (highest bitrate)
      const best = audioStreams
        .filter((s) => s.url && s.mimeType?.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (!best?.url) continue;

      console.log(`[Piped] Stream: ${best.mimeType} ${best.bitrate}bps`);

      // Convert to MP3 via ffmpeg
      const ffmpegBin = ffmpegDir
        ? path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
        : 'ffmpeg';

      await new Promise<void>((resolve, reject) => {
        execFile(
          ffmpegBin,
          ['-y', '-i', best.url, '-vn', '-acodec', 'libmp3lame', '-ab', '192k', outputPath],
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

      // Verify file is a real song (not a tiny preview)
      if (fs.existsSync(outputPath)) {
        const size = fs.statSync(outputPath).size;
        if (size > 500_000) { // >500KB = likely a full song
          console.log(`[Piped] Success: ${(size / 1_048_576).toFixed(1)} MB`);
          return outputPath;
        }
        console.warn(`[Piped] File too small (${size} bytes), discarding`);
        fs.unlinkSync(outputPath);
      }
    } catch (e: any) {
      console.warn(`[Piped] ${instance} failed: ${e.message?.substring(0, 200)}`);
    }
  }

  throw new Error('Piped download failed from all instances');
}

/** Check if a song is already cached */
export function isCached(trackId: string): boolean {
  return fs.existsSync(path.join(DOWNLOADS_DIR, `${trackId}.mp3`));
}
