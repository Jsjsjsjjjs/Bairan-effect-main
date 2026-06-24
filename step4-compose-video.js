const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const workDir = process.argv[2] || '.';
const OUTPUT_DIR = path.join(workDir, 'output');
const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';
const MAIN = path.join(workDir, 'main-video.MP4');
const MIDDLE_SLIDESHOW = path.join(OUTPUT_DIR, 'middle-slideshow.mp4');
const MIDDLE_VIDEO = path.join(workDir, 'middle-video.mp4');
const MIDDLE = fs.existsSync(MIDDLE_SLIDESHOW) ? MIDDLE_SLIDESHOW : MIDDLE_VIDEO;
const STICKER = path.join(OUTPUT_DIR, 'bordered-image.png');
const AUDIO_FILE = path.join(__dirname, 'barain.mp3');
const OUTPUT = path.join(OUTPUT_DIR, 'final-video.mp4');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Get video duration in fractional seconds using ffprobe JSON output.
 * Cross-platform: no shell pipe or grep needed.
 */
function getDur(file) {
  const result = spawnSync(FFPROBE, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    file
  ], { encoding: 'utf8' });

  if (result.error) throw new Error(`ffprobe failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffprobe exited with code ${result.status}: ${result.stderr}`);

  const data = JSON.parse(result.stdout);
  const duration = parseFloat(data.format.duration);
  if (isNaN(duration)) throw new Error(`Could not parse duration from: ${file}`);
  return duration; // Returns precise float (e.g. 5.033333)
}

function main() {
  console.log('🎬 Creating CENTER-OUT curtain\n');
  console.log(`WorkDir: ${workDir}`);

  if (!fs.existsSync(MAIN)) throw new Error(`Main video not found: ${MAIN}`);
  if (!fs.existsSync(MIDDLE)) throw new Error(`Middle video not found: ${MIDDLE}`);
  if (!fs.existsSync(STICKER)) throw new Error(`Sticker image not found: ${STICKER}`);

  const middleSource = MIDDLE === MIDDLE_SLIDESHOW ? 'middle-slideshow' : 'middle-video';
  console.log(`Using: ${middleSource}\n`);

  const mainDur = getDur(MAIN);
  const midDur = getDur(MIDDLE);
  const total = mainDur + midDur;

  console.log(`Main: ${mainDur.toFixed(3)}s | Middle: ${midDur.toFixed(3)}s | Total: ${total.toFixed(3)}s\n`);

  // ─── Step 1: Create extended-main (original + freeze of last frame) ───────
  console.log('Step 1: Extended main...');
  const freezeDuration = total - mainDur; // = midDur
  try {
    // Extract last frame
    execSync(`${FFMPEG} -i "${MAIN}" -ss ${mainDur - 0.1} -vframes 1 "${OUTPUT_DIR}/last-frame-for-loop.png" -y`, { stdio: 'inherit' });
    // Create freeze loop from last frame
    execSync(`${FFMPEG} -loop 1 -i "${OUTPUT_DIR}/last-frame-for-loop.png" -vf "format=yuv420p,fps=60,scale=1080:1920" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r 60 -t ${freezeDuration} "${OUTPUT_DIR}/freeze-extension.mp4" -y`, { stdio: 'inherit' });
    // Concatenate original + freeze via filter_complex (works on all platforms)
    execSync(`${FFMPEG} -i "${MAIN}" -i "${OUTPUT_DIR}/freeze-extension.mp4" -filter_complex "[0:v]fps=60,scale=1080:1920[v0];[1:v]fps=60,scale=1080:1920[v1];[v0][v1]concat=n=2:v=1:a=0[out]" -map [out] -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r 60 "${OUTPUT_DIR}/extended-main.mp4" -y`, { stdio: 'inherit' });
    console.log('✓ Done\n');
  } catch (err) {
    console.error('❌ Step 1 failed:', err.message);
    throw err;
  }

  // ─── Step 2: Center-out curtain reveal ────────────────────────────────────
  console.log('Step 2: Center-out curtain (frozen main frame bg)...');
  try {
    // Scale middle to target resolution
    execSync(`${FFMPEG} -i "${MIDDLE}" -vf "format=yuv420p,fps=60,scale=1080:1920" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r 60 -t ${midDur} "${OUTPUT_DIR}/middle-scaled.mp4" -y`, { stdio: 'inherit' });

    // Extract frozen frame from end of extended main for bg
    execSync(`${FFMPEG} -i "${OUTPUT_DIR}/extended-main.mp4" -ss ${mainDur - 0.1} -vframes 1 "${OUTPUT_DIR}/frozen-frame.png" -y`, { stdio: 'inherit' });
    execSync(`${FFMPEG} -loop 1 -i "${OUTPUT_DIR}/frozen-frame.png" -vf "format=yuv420p,fps=60,scale=1080:1920" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r 60 -t ${midDur} "${OUTPUT_DIR}/frozen-bg.mp4" -y`, { stdio: 'inherit' });

    // Center-out blend: reveal middle from center expanding outward
    const centerY = 960; // 1920 / 2
    const halfH = 960;   // 1920 / 2

    execSync(
      `${FFMPEG} -i "${OUTPUT_DIR}/frozen-bg.mp4" -i "${OUTPUT_DIR}/middle-scaled.mp4"` +
      ` -filter_complex "[0:v]format=yuv420p[bg];[1:v]format=yuv420p[fg];` +
      `[bg][fg]blend=all_expr='if(between(Y,${centerY}-(${halfH}*T/${midDur}),${centerY}+(${halfH}*T/${midDur})),B,A)':shortest=1[out]"` +
      ` -map [out] -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r 60 -t ${midDur} "${OUTPUT_DIR}/middle-curtain.mp4" -y`,
      { stdio: 'inherit' }
    );
    console.log('✓ Done\n');
  } catch (err) {
    console.error('❌ Step 2 failed:', err.message);
    throw err;
  }

  // ─── Step 3: Final composition — overlay + sticker + camera shake + audio ─
  console.log('Step 3: Final composition with audio and shake...');
  try {
    const hasAudio = fs.existsSync(AUDIO_FILE);
    const audioInput  = hasAudio ? `-stream_loop -1 -i "${AUDIO_FILE}"` : '';
    const audioMap    = hasAudio ? `-map [out_a] -c:a aac -b:a 192k` : '';
    const audioFilter = hasAudio ? `;[3:a]anull[out_a]` : '';

    execSync(
      `${FFMPEG} -i "${OUTPUT_DIR}/extended-main.mp4" -i "${OUTPUT_DIR}/middle-curtain.mp4" -i "${STICKER}" ${audioInput}` +
      ` -filter_complex "` +
        `[0:v]format=yuv420p,fps=60,scale=1080:1920[v0];` +
        `[1:v]format=yuv420p,setpts=PTS+${mainDur}/TB,fps=60,scale=1080:1920[mid];` +
        `[2:v]format=yuv420p,loop=-1:1,setpts=PTS+${mainDur}/TB,fps=60,` +
          `scale='trunc(iw*max(0.6,1-pow(sin((t-${mainDur})/(${total}-${mainDur})*1.5708),2)*0.4)/2)*2` +
             `:trunc(ih*max(0.6,1-pow(sin((t-${mainDur})/(${total}-${mainDur})*1.5708),2)*0.4)/2)*2':eval=frame[sticker];` +
        `[v0][mid]overlay=0:0:shortest=1[tmp];` +
        `[tmp][sticker]overlay=(W-w)/2:H-h:shortest=1[comp];` +
        `[comp]crop=iw-40:ih-40:20+15*sin(t*7):20+15*cos(t*9)[shake];` +
        `[shake]scale=1080:1920,format=yuv420p[out_v]${audioFilter}"` +
      ` -map [out_v] ${audioMap} -c:v libx264 -pix_fmt yuv420p -r 60 -t ${total} "${OUTPUT}" -y`,
      { stdio: 'inherit' }
    );

    console.log('\n✅ Done!');
    console.log(`🎉 ${OUTPUT}`);
  } catch (err) {
    console.error('❌ Step 3 failed:', err.message);
    throw err;
  }
}

main();
