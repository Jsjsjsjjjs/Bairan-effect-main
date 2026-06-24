const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const heicConvert = require('heic-convert');
const sharp = require('sharp');

const FFMPEG = 'ffmpeg';
const IMAGES_DIR = process.argv[2] || 'middle-images';
const OUTPUT    = process.argv[3] || path.join(__dirname, 'output/middle-slideshow.mp4');
const DURATION      = 9;    // Total slideshow duration in seconds
const IMAGE_DURATION = 0.20; // Each image displays for 200ms

// Target resolution — pre-scale here so ffmpeg never has to swscale
const TARGET_W = 1080;
const TARGET_H = 1920;

const OUTPUT_DIR = path.dirname(OUTPUT);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function createSlideshow() {
  console.log(`🎬 Creating slideshow from ${IMAGES_DIR}`);
  console.log(`Output: ${OUTPUT}`);

  if (!fs.existsSync(IMAGES_DIR)) {
    console.error(`❌ Images directory not found: ${IMAGES_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(IMAGES_DIR)
    .filter(f => /\.(jpg|jpeg|png|heic|HEIC|JPG|JPEG|webp|WEBP|jfif|JFIF)$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`❌ No images found in ${IMAGES_DIR}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} images, each for ${IMAGE_DURATION}s`);

  const totalFrames = Math.ceil(DURATION / IMAGE_DURATION);
  console.log(`Total slideshow slots: ${totalFrames}`);

  const tempDir = path.join(OUTPUT_DIR, 'temp-slideshow-imgs');
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  // ─── Convert + PRE-SCALE images with Sharp ───────────────────────────────
  // We scale to TARGET resolution HERE in Node.js so ffmpeg never needs
  // swscale at all — eliminating the OOM-causing multi-threaded swscaler.
  console.log(`\nConverting & scaling to ${TARGET_W}x${TARGET_H} (sequential to save RAM)...`);

  const convertImage = async (file, idx) => {
    const ext = path.extname(file).toLowerCase();
    // Write as PNG — no lossy re-compression, exact pixel format control
    const outPath = path.join(tempDir, `img_${String(idx).padStart(3, '0')}.png`);
    const inputPath = path.join(IMAGES_DIR, file);

    try {
      let inputBuffer;

      if (ext === '.heic') {
        const raw = fs.readFileSync(inputPath);
        const convertFn = (heicConvert && heicConvert.convert) ? heicConvert.convert : heicConvert;
        const jpegBuf = await convertFn({ buffer: raw, format: 'JPEG', quality: 0.92 });
        inputBuffer = Buffer.from(jpegBuf);
      } else {
        inputBuffer = fs.readFileSync(inputPath);
      }

      await sharp(inputBuffer)
        .resize(TARGET_W, TARGET_H, {
          fit: 'contain',             // Letterbox/pillarbox to preserve aspect ratio
          background: { r: 0, g: 0, b: 0, alpha: 1 }
        })
        .flatten({ background: { r: 0, g: 0, b: 0 } }) // Remove alpha → solid black bg
        .png({ compressionLevel: 1 }) // Fast, minimal compression (speed > size here)
        .toFile(outPath);

      return { file, idx, outPath, success: true };
    } catch (e) {
      console.warn(`  ⚠ Skipping ${file}: ${e.message}`);
      return { file, idx, success: false, error: e.message };
    }
  };

  // Process sequentially to avoid RAM spikes from parallel sharp operations
  const results = [];
  for (let i = 0; i < files.length; i++) {
    process.stdout.write(`  [${i + 1}/${files.length}] ${files[i]} ... `);
    const r = await convertImage(files[i], i + 1);
    console.log(r.success ? '✓' : `✗ ${r.error}`);
    results.push(r);
  }

  const succeeded = results.filter(r => r.success);
  if (succeeded.length === 0) {
    console.error('❌ All image conversions failed. Cannot create slideshow.');
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`\n✓ ${succeeded.length}/${files.length} images ready\n`);

  // ─── Build ffmpeg concat list ─────────────────────────────────────────────
  const listFile = path.join(tempDir, 'list.txt');
  let listContent = '';

  for (let i = 0; i < totalFrames; i++) {
    const img = succeeded[i % succeeded.length];
    // ffmpeg concat demuxer requires forward slashes even on Windows
    const p = img.outPath.replace(/\\/g, '/');
    listContent += `file '${p}'\n`;
    listContent += `duration ${IMAGE_DURATION}\n`;
  }
  // Concat demuxer: repeat last entry without duration
  const lastImg = succeeded[(totalFrames - 1) % succeeded.length];
  listContent += `file '${lastImg.outPath.replace(/\\/g, '/')}'\n`;

  fs.writeFileSync(listFile, listContent, 'utf8');

  // ─── FFmpeg encode — images already scaled, just encode ───────────────────
  // -threads 1    → single-threaded = no multi-swscaler OOM
  // -preset ultrafast → lowest RAM during encoding  
  // -crf 23       → reasonable quality, lower memory than crf 18
  // NO scale/pad filter needed — images are pre-scaled by Sharp
  const absOutput   = path.resolve(OUTPUT).replace(/\\/g, '/');
  const absListFile = path.resolve(listFile).replace(/\\/g, '/');

  const cmd = (
    `${FFMPEG} -y` +
    ` -threads 1` +                           // ← CRITICAL: prevents OOM kill
    ` -f concat -safe 0 -i "${absListFile}"` +
    ` -r 30` +
    ` -vf "format=yuv420p,setsar=1"` +        // Just format conversion — no scale needed
    ` -c:v libx264 -preset ultrafast` +        // ← Low RAM encoder preset
    ` -crf 23 -pix_fmt yuv420p` +
    ` -t ${DURATION}` +
    ` "${absOutput}"`
  );

  console.log('Encoding slideshow...');
  console.log(`CMD: ${cmd}\n`);

  try {
    execSync(cmd, { stdio: 'inherit' });
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`\n✅ Slideshow saved: ${OUTPUT}`);
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    console.error('❌ FFmpeg encode failed:', err.message);
    throw err;
  }
}

createSlideshow().catch(err => {
  console.error('❌ Fatal:', err.message || err);
  process.exit(1);
});
