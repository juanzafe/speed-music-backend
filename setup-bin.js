const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN_DIR = path.join(__dirname, 'bin');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  const isLinux = process.platform === 'linux';
  if (!isLinux) {
    console.log('Skipping binary download (not Linux)');
    return;
  }

  // Download yt-dlp
  const ytdlpPath = path.join(BIN_DIR, 'yt-dlp');
  if (!fs.existsSync(ytdlpPath)) {
    console.log('Downloading yt-dlp...');
    await download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', ytdlpPath);
    fs.chmodSync(ytdlpPath, 0o755);
    console.log('yt-dlp downloaded');
  }

  // Download ffmpeg static build
  const ffmpegPath = path.join(BIN_DIR, 'ffmpeg');
  if (!fs.existsSync(ffmpegPath)) {
    console.log('Downloading ffmpeg static...');
    const tarPath = path.join(BIN_DIR, 'ffmpeg.tar.xz');
    await download(
      'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
      tarPath
    );
    console.log('Extracting ffmpeg...');
    execFileSync('tar', ['-xf', tarPath, '--wildcards', '*/ffmpeg', '--strip-components=1', '-C', BIN_DIR]);
    fs.unlinkSync(tarPath);
    fs.chmodSync(ffmpegPath, 0o755);
    console.log('ffmpeg extracted');
  }

  // Verify
  try {
    const v = execFileSync(ytdlpPath, ['--version'], { encoding: 'utf8' }).trim();
    console.log('yt-dlp version:', v);
  } catch (e) {
    console.error('yt-dlp verification failed:', e.message);
  }

  try {
    const v = execFileSync(ffmpegPath, ['-version'], { encoding: 'utf8' }).split('\n')[0];
    console.log('ffmpeg:', v);
  } catch (e) {
    console.error('ffmpeg verification failed:', e.message);
  }
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
