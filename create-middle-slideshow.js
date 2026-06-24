const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const heicConvert = require('heic-convert');
const sharp = require('sharp');

const FFMPEG = 'ffmpeg';
const IMAGES_DIR = process.argv[2] || 'middle-images';
const OUTPUT = process.argv[3] || path.join(__dirname, 'output/middle-slideshow.mp4');
const DURATION = 9;          // Total slideshow duration in seconds
const IMAGE_DURATION = 0.20; // Each image displays for 200ms

const OUTPUT_DIR = path.dirname(OUTPUT);
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function createSlideshow() {
  console.log(`🎬 Creating looping slideshow from ${IMAGES_DIR}\n`);
  console.log(`Output: ${OUTPUT}\n`);

  if (!fs.existsSync(IMAGES_DIR)) {
    console.error(`Images directory not found: ${IMAGES_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(IMAGES_DIR)
    .filter(f => /\.(jpg|jpeg|png|heic|HEIC|JPG|JPEG|webp|WEBP|jfif|JFIF)$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`No images found in ${IMAGES_DIR}`);
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

  console.log('Converting to JPG (parallel)...');

  const convertImage = async (file, idx) => {
    const ext = path.extname(file).toLowerCase();
    const jpgPath = path.join(tempDir, `img_${String(idx).padStart(2, '0')}.jpg`);
    const inputPath = path.join(IMAGES_DIR, file);

    try {
      if (ext === '.heic') {
        const inputBuffer = fs.readFileSync(inputPath);
        // heic-convert v2: module exports { convert }, older versions export fn directly
        const convertFn = (heicConvert && heicConvert.convert) ? heicConvert.convert : heicConvert;
        const outputBuffer = await convertFn({
          buffer: inputBuffer,
          format: 'JPEG',
          quality: 0.95
        });
        fs.writeFileSync(jpgPath, Buffer.from(outputBuffer));
      } else {
        await sharp(inputPath)
          .jpeg({ quality: 90 })
          .toFile(jpgPath);
      }
      return { file, idx, success: true };
    } catch (e) {
      return { file, idx, success: false, error: e.message };
    }
  };

  const convertPromises = files.map((file, idx) => convertImage(file, idx + 1));
  const results = await Promise.all(convertPromises);

  const succeeded = results.filter(r => r.success);
  const failed    = results.filter(r => !r.success);

  console.log(`✓ Converted ${succeeded.length}/${files.length} images`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(`  ✗ Failed: ${f.file} — ${f.error}`));
  }

  // Abort if no images were successfully converted
  if (succeeded.length === 0) {
    console.error('❌ All image conversions failed. Cannot create slideshow.');
    // Clean up empty temp dir
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log('');

  // Build ffmpeg concat list — only include successfully converted images
  const listFile = path.join(tempDir, 'list.txt');
  let listContent = '';

  // Map original index → converted jpg path (only successful ones)
  const validImgs = succeeded.map(r => ({
    idx: r.idx,
    // Use forward slashes — ffmpeg requires this even on Windows for concat demuxer
    filePath: path.resolve(tempDir, `img_${String(r.idx).padStart(2, '0')}.jpg`).replace(/\\/g, '/')
  }));

  if (validImgs.length === 0) {
    console.error('No converted images available.');
    process.exit(1);
  }

  // Loop the valid images to fill totalFrames
  for (let i = 0; i < totalFrames; i++) {
    const img = validImgs[i % validImgs.length];
    listContent += `file '${img.filePath}'\n`;
    listContent += `duration ${IMAGE_DURATION}\n`;
  }

  // FFmpeg concat demuxer: must repeat last entry without duration
  const lastImg = validImgs[(totalFrames - 1) % validImgs.length];
  listContent += `file '${lastImg.filePath}'\n`;

  fs.writeFileSync(listFile, listContent, 'utf8');
  console.log('Created image list file');

  // Forward-slash paths for ffmpeg (safe on Linux/macOS, also works on Windows ffmpeg)
  const absoluteOutput   = path.resolve(OUTPUT).replace(/\\/g, '/');
  const absoluteListFile = path.resolve(listFile).replace(/\\/g, '/');

  console.log('Generating slideshow video...');
  try {
    execSync(
      `${FFMPEG} -y -f concat -safe 0 -i "${absoluteListFile}"` +
      ` -r 30 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1"` +
      ` -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -t ${DURATION} "${absoluteOutput}"`,
      { stdio: 'inherit' }
    );

    // Cleanup temp dir after success
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`✅ Saved: ${OUTPUT}`);
  } catch (err) {
    // Also cleanup on failure to avoid leaving orphaned temp files
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    console.error('❌ FFMPEG slideshow generation failed:', err.message);
    throw err;
  }
}

createSlideshow().catch(err => {
  console.error('❌ Error:', err.message || err);
  process.exit(1);
});
