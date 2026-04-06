import { execFile, execFileSync, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

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

  // Ensure binaries are available (downloads on first call)
  const { ytdlp, ffmpegDir } = await ensureBinaries();

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
      '--extractor-args', 'youtube:player_client=web',
    ];

    if (ffmpegDir) {
      args.push('--ffmpeg-location', ffmpegDir);
    }

    console.log(`Running: ${ytdlp} ${args.join(' ')}`);

    // Include bin/ in PATH so yt-dlp can find node for JS challenges
    const env = { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH}` };

    execFile(ytdlp, args, { timeout: 120_000, env }, (error, stdout, stderr) => {
      // yt-dlp exits with non-zero when --max-downloads is hit, but the file is still produced
      if (fs.existsSync(outputPath)) {
        resolve(outputPath);
        return;
      }

      if (error) {
        console.error('yt-dlp stderr:', stderr);
        console.error('yt-dlp stdout:', stdout);
        console.error('yt-dlp error:', error.message);
        reject(new Error(`yt-dlp failed: ${stderr || error.message}`));
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
