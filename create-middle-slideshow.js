const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const heicConvert = require('heic-convert');
const sharp = require('sharp');

const FFMPEG = 'ffmpeg';
const IMAGES_DIR = process.argv[2] || 'middle-images';
const OUTPUT = process.argv[3] || path.join(__dirname, 'output/middle-slideshow.mp4');
const DURATION = 9;          // Total slideshow duration in seconds
const IMAGE_DURATION = 0.20; // Each image displays for 200ms (fast flip effect)

// ── RAM budget: Railway starter = ~512MB, shared with Node + sharp ──────────
// Keep ffmpeg under ~200MB by using:
//   - ultrafast preset (lowest encoder RAM)
//   - 2 threads max (each thread has its own scale context)
//   - crf 28 (adequate for a 9s transition clip, not the final video)
//   - Serialize image conversions (not parallel) to avoid spike
const FFMPEG_THREADS = 2;
const FFMPEG_CRF     = 26;   // Quality good enough for middle transition
const FFMPEG_PRESET  = 'ultrafast'; // Lowest RAM footprint

const OUTPUT_DIR = path.dirname(OUTPUT);
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function createSlideshow() {
  console.log(`🎬 Creating looping slideshow from ${IMAGES_DIR}\n`);
  console.log(`Output: ${OUTPUT}\n`);

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

  console.log(`Found ${files.length} images`);
  console.log(`Each image displays for ${IMAGE_DURATION}s`);

  const totalFrames = Math.ceil(DURATION / IMAGE_DURATION);
  console.log(`Total frames: ${totalFrames}\n`);

  const tempDir = path.join(OUTPUT_DIR, 'temp-images');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // ── Convert images SEQUENTIALLY to avoid RAM spike ───────────────────────
  // Parallel sharp + heic-convert on many large images will OOM on Railway.
  console.log('Converting to JPG (sequential, RAM-safe)...');

  const convertImage = async (file, idx) => {
    const ext = path.extname(file).toLowerCase();
    const jpgPath = path.join(tempDir, `img_${String(idx).padStart(2, '0')}.jpg`);
    const inputPath = path.join(IMAGES_DIR, file);

    try {
      if (ext === '.heic') {
        const inputBuffer = fs.readFileSync(inputPath);
        const convertFn = (heicConvert && heicConvert.convert) ? heicConvert.convert : heicConvert;
        const outputBuffer = await convertFn({
          buffer: inputBuffer,
          format: 'JPEG',
          quality: 0.85  // Slightly lower quality to save RAM during conversion
        });
        fs.writeFileSync(jpgPath, Buffer.from(outputBuffer));
      } else {
        await sharp(inputPath)
          .resize(1080, 1920, {         // Pre-resize during conversion = less RAM for ffmpeg
            fit: 'inside',
            withoutEnlargement: false
          })
          .jpeg({ quality: 85, mozjpeg: false })
          .toFile(jpgPath);
      }
      return { file, idx, success: true };
    } catch (e) {
      return { file, idx, success: false, error: e.message };
    }
  };

  // Sequential processing: avoids multiple sharp instances in RAM simultaneously
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const result = await convertImage(files[i], i + 1);
    if (result.success) {
      console.log(`  ✓ [${i + 1}/${files.length}] ${files[i]}`);
    } else {
      console.log(`  ✗ [${i + 1}/${files.length}] ${files[i]} — ${result.error}`);
    }
    results.push(result);
  }

  const succeeded = results.filter(r => r.success);
  const failed    = results.filter(r => !r.success);

  console.log(`\n✓ Converted ${succeeded.length}/${files.length} images`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(`  ✗ Failed: ${f.file} — ${f.error}`));
  }

  if (succeeded.length === 0) {
    console.error('❌ All image conversions failed. Cannot create slideshow.');
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
  }
  console.log('');

  // ── Build ffmpeg concat list from successfully converted images ───────────
  const listFile = path.join(tempDir, 'list.txt');
  let listContent = '';

  const validImgs = succeeded.map(r => ({
    idx: r.idx,
    filePath: path.resolve(tempDir, `img_${String(r.idx).padStart(2, '0')}.jpg`).replace(/\\/g, '/')
  }));

  // Loop images to fill totalFrames
  for (let i = 0; i < totalFrames; i++) {
    const img = validImgs[i % validImgs.length];
    listContent += `file '${img.filePath}'\n`;
    listContent += `duration ${IMAGE_DURATION}\n`;
  }

  // FFmpeg concat demuxer requirement: repeat last file without duration
  const lastImg = validImgs[(totalFrames - 1) % validImgs.length];
  listContent += `file '${lastImg.filePath}'\n`;

  fs.writeFileSync(listFile, listContent, 'utf8');
  console.log('Created image list file');

  const absoluteOutput   = path.resolve(OUTPUT).replace(/\\/g, '/');
  const absoluteListFile = path.resolve(listFile).replace(/\\/g, '/');

  // ── FFmpeg: memory-safe encoding ──────────────────────────────────────────
  // Key settings to prevent OOM kill on Railway:
  //   -threads 2        → cap scale/encode thread count (each thread = RAM)
  //   -preset ultrafast → lowest libx264 RAM footprint
  //   -crf 26           → good enough for a 9s transition clip
  //   scale with sws_flags=fast_bilinear → less RAM than default lanczos
  //   format=yuv420p first → avoids deprecated yuvj420p swscaler warning
  //   -bufsize 4M       → cap encoder lookahead buffer
  //
  // Images were pre-resized by sharp to ~1080 wide, so ffmpeg scale does less work.
  console.log(`Generating slideshow video (threads=${FFMPEG_THREADS}, preset=${FFMPEG_PRESET}, crf=${FFMPEG_CRF})...`);
  try {
    execSync(
      `${FFMPEG} -y -threads ${FFMPEG_THREADS} -f concat -safe 0 -i "${absoluteListFile}"` +
      ` -r 30` +
      ` -vf "format=yuv420p,scale=1080:1920:force_original_aspect_ratio=decrease:sws_flags=fast_bilinear,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"` +
      ` -c:v libx264 -preset ${FFMPEG_PRESET} -crf ${FFMPEG_CRF} -pix_fmt yuv420p` +
      ` -threads ${FFMPEG_THREADS} -bufsize 4M` +
      ` -t ${DURATION} "${absoluteOutput}"`,
      {
        stdio: 'inherit',
        maxBuffer: 10 * 1024 * 1024  // 10MB stdout buffer for long operations
      }
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`✅ Saved: ${OUTPUT}`);
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    console.error('❌ FFMPEG slideshow generation failed:', err.message);
    throw err;
  }
}

createSlideshow().catch(err => {
  console.error('❌ Error:', err.message || err);
  process.exit(1);
});
