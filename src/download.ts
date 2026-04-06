import { execFile, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

/** Resolve yt-dlp binary path */
function findYtDlp(): string {
  // Check local bin/ directory first (downloaded by setup-bin.js)
  const localBin = path.join(__dirname, '..', 'bin', 'yt-dlp');
  if (fs.existsSync(localBin)) return localBin;

  // On Linux / Docker, check PATH
  if (process.platform !== 'win32') {
    if (fs.existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
    return 'yt-dlp';
  }

  const localAppData = process.env.LOCALAPPDATA || '';

  // Check winget Links folder
  const linksPath = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe');
  if (fs.existsSync(linksPath)) return linksPath;

  // Check winget Packages folder (common on Windows)
  const packagesDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(packagesDir)) {
    const dirs = fs.readdirSync(packagesDir).filter(d => d.startsWith('yt-dlp.yt-dlp'));
    for (const dir of dirs) {
      const exe = path.join(packagesDir, dir, 'yt-dlp.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }

  // Fallback to PATH
  return 'yt-dlp';
}

/** Resolve ffmpeg directory for yt-dlp */
function findFfmpegDir(): string | undefined {
  // Check local bin/ directory first (downloaded by setup-bin.js)
  const localBin = path.join(__dirname, '..', 'bin');
  if (fs.existsSync(path.join(localBin, 'ffmpeg'))) return localBin;
  if (fs.existsSync(path.join(localBin, 'ffmpeg.exe'))) return localBin;

  // On Linux / Docker, ffmpeg is in PATH — no need to specify
  if (process.platform !== 'win32') return undefined;

  const localAppData = process.env.LOCALAPPDATA || '';
  const packagesDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(packagesDir)) {
    const dirs = fs.readdirSync(packagesDir).filter(d => d.startsWith('yt-dlp.FFmpeg'));
    for (const dir of dirs) {
      const binDir = path.join(packagesDir, dir);
      // ffmpeg might be nested in a subfolder
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

const YT_DLP = findYtDlp();
const FFMPEG_DIR = findFfmpegDir();

console.log('yt-dlp path:', YT_DLP);
console.log('yt-dlp exists:', fs.existsSync(YT_DLP));
console.log('ffmpeg dir:', FFMPEG_DIR);
console.log('platform:', process.platform);

export { YT_DLP, FFMPEG_DIR };

/**
 * Downloads a full song from YouTube using yt-dlp.
 * Searches by "{title} {artist}" and picks the best audio match.
 * Returns the path to the downloaded mp3 file.
 */
export async function downloadSong(
  trackId: string,
  title: string,
  artist: string
): Promise<string> {
  const outputPath = path.join(DOWNLOADS_DIR, `${trackId}.mp3`);

  // If already downloaded, return cached file
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  const query = `${title} ${artist}`;

  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch1:${query}`,
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '--no-playlist',
      '--max-downloads', '1',
      '--output', outputPath.replace('.mp3', '.%(ext)s'),
      '--no-warnings',
    ];

    if (FFMPEG_DIR) {
      args.push('--ffmpeg-location', FFMPEG_DIR);
    }

    console.log(`Running: ${YT_DLP} ${args.join(' ')}`);

    execFile(YT_DLP, args, { timeout: 120_000 }, (error, stdout, stderr) => {
      // yt-dlp exits with non-zero when --max-downloads is hit, but the file is still produced
      if (fs.existsSync(outputPath)) {
        resolve(outputPath);
        return;
      }

      if (error) {
        console.error('yt-dlp stderr:', stderr);
        console.error('yt-dlp stdout:', stdout);
        console.error('yt-dlp error:', error.message);
        reject(new Error('Error descargando canción'));
        return;
      }

      // List files to debug
      const files = fs.readdirSync(DOWNLOADS_DIR);
      console.error('Files in downloads:', files);
      reject(new Error('Archivo no encontrado después de la descarga'));
    });
  });
}

/** Check if a song is already cached */
export function isCached(trackId: string): boolean {
  return fs.existsSync(path.join(DOWNLOADS_DIR, `${trackId}.mp3`));
}
