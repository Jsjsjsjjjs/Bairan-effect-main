const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const workDir = process.argv[2] || '.';
const OUTPUT_DIR = path.join(workDir, 'output');
const FFMPEG  = 'ffmpeg';
const FFPROBE = 'ffprobe';
const MAIN             = path.join(workDir, 'main-video.MP4');
const MIDDLE_SLIDESHOW = path.join(OUTPUT_DIR, 'middle-slideshow.mp4');
const MIDDLE_VIDEO     = path.join(workDir, 'middle-video.mp4');
const MIDDLE  = fs.existsSync(MIDDLE_SLIDESHOW) ? MIDDLE_SLIDESHOW : MIDDLE_VIDEO;
const STICKER = path.join(OUTPUT_DIR, 'bordered-image.png');
const AUDIO_FILE = path.join(__dirname, 'barain.mp3');
const OUTPUT  = path.join(OUTPUT_DIR, 'final-video.mp4');

// ── RAM-safe encoding settings for Railway (512MB–1GB container) ─────────
const THREADS = 2;
const PRESET  = 'ultrafast';

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Get precise video duration via ffprobe JSON — cross-platform, no shell pipe.
 */
function getDur(file) {
  const result = spawnSync(FFPROBE, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    file
  ], { encoding: 'utf8' });

  if (result.error) throw new Error(`ffprobe failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffprobe exited ${result.status}: ${result.stderr}`);

  const data = JSON.parse(result.stdout);
  const duration = parseFloat(data.format.duration);
  if (isNaN(duration)) throw new Error(`Could not parse duration from: ${file}`);
  return duration;
}

/** Run an ffmpeg command with RAM-safe options */
function ff(cmd) {
  execSync(cmd, { stdio: 'inherit', maxBuffer: 10 * 1024 * 1024 });
}

function main() {
  console.log('🎬 Creating CENTER-OUT curtain\n');
  console.log(`WorkDir: ${workDir}`);

  if (!fs.existsSync(MAIN))    throw new Error(`Main video not found: ${MAIN}`);
  if (!fs.existsSync(MIDDLE))  throw new Error(`Middle video not found: ${MIDDLE}`);
  if (!fs.existsSync(STICKER)) throw new Error(`Sticker image not found: ${STICKER}`);

  const middleSource = MIDDLE === MIDDLE_SLIDESHOW ? 'middle-slideshow' : 'middle-video';
  console.log(`Using: ${middleSource}\n`);

  const mainDur = getDur(MAIN);
  const midDur  = getDur(MIDDLE);
  const total   = mainDur + midDur;
  console.log(`Main: ${mainDur.toFixed(3)}s | Middle: ${midDur.toFixed(3)}s | Total: ${total.toFixed(3)}s\n`);

  // Common filter flags to minimize RAM: threads, fast_bilinear, ultrafast
  const T = THREADS;
  const P = PRESET;

  // ─── Step 1: extended-main = original video + frozen last frame ──────────
  console.log('Step 1: Extended main...');
  const freezeDuration = midDur; // hold last frame for duration of middle section
  try {
    // Extract last frame as PNG
    ff(`${FFMPEG} -threads ${T} -i "${MAIN}" -ss ${mainDur - 0.1} -vframes 1 "${OUTPUT_DIR}/last-frame-for-loop.png" -y`);

    // Loop last frame into a freeze clip
    ff(`${FFMPEG} -threads ${T} -loop 1 -i "${OUTPUT_DIR}/last-frame-for-loop.png"` +
       ` -vf "format=yuv420p,scale=1080:1920:sws_flags=fast_bilinear"` +
       ` -c:v libx264 -preset ${P} -pix_fmt yuv420p -threads ${T} -r 60 -t ${freezeDuration}` +
       ` "${OUTPUT_DIR}/freeze-extension.mp4" -y`);

    // Concatenate original + freeze
    ff(`${FFMPEG} -threads ${T} -i "${MAIN}" -i "${OUTPUT_DIR}/freeze-extension.mp4"` +
       ` -filter_complex "[0:v]format=yuv420p,fps=60,scale=1080:1920:sws_flags=fast_bilinear[v0];` +
                         `[1:v]format=yuv420p,fps=60,scale=1080:1920:sws_flags=fast_bilinear[v1];` +
                         `[v0][v1]concat=n=2:v=1:a=0[out]"` +
       ` -map [out] -c:v libx264 -preset ${P} -pix_fmt yuv420p -threads ${T} -r 60` +
       ` "${OUTPUT_DIR}/extended-main.mp4" -y`);

    console.log('✓ Done\n');
  } catch (err) {
    console.error('❌ Step 1 failed:', err.message);
    throw err;
  }

  // ─── Step 2: Center-out curtain reveal ────────────────────────────────────
  console.log('Step 2: Center-out curtain...');
  try {
    // Scale middle slideshow to 60fps 1080x1920
    ff(`${FFMPEG} -threads ${T} -i "${MIDDLE}"` +
       ` -vf "format=yuv420p,fps=60,scale=1080:1920:sws_flags=fast_bilinear"` +
       ` -c:v libx264 -preset ${P} -pix_fmt yuv420p -threads ${T} -r 60 -t ${midDur}` +
       ` "${OUTPUT_DIR}/middle-scaled.mp4" -y`);

    // Extract frozen frame from extended main at the transition point
    ff(`${FFMPEG} -threads ${T} -i "${OUTPUT_DIR}/extended-main.mp4"` +
       ` -ss ${mainDur - 0.1} -vframes 1 "${OUTPUT_DIR}/frozen-frame.png" -y`);

    // Loop frozen frame as background for duration of middle section
    ff(`${FFMPEG} -threads ${T} -loop 1 -i "${OUTPUT_DIR}/frozen-frame.png"` +
       ` -vf "format=yuv420p,fps=60,scale=1080:1920:sws_flags=fast_bilinear"` +
       ` -c:v libx264 -preset ${P} -pix_fmt yuv420p -threads ${T} -r 60 -t ${midDur}` +
       ` "${OUTPUT_DIR}/frozen-bg.mp4" -y`);

    // Blend: center-out curtain expanding from center Y outward
    const centerY = 960;
    const halfH   = 960;
    ff(`${FFMPEG} -threads ${T} -i "${OUTPUT_DIR}/frozen-bg.mp4" -i "${OUTPUT_DIR}/middle-scaled.mp4"` +
       ` -filter_complex "[0:v]format=yuv420p[bg];[1:v]format=yuv420p[fg];` +
                         `[bg][fg]blend=all_expr='if(between(Y,${centerY}-(${halfH}*T/${midDur}),${centerY}+(${halfH}*T/${midDur})),B,A)':shortest=1[out]"` +
       ` -map [out] -c:v libx264 -preset ${P} -pix_fmt yuv420p -threads ${T} -r 60 -t ${midDur}` +
       ` "${OUTPUT_DIR}/middle-curtain.mp4" -y`);

    console.log('✓ Done\n');
  } catch (err) {
    console.error('❌ Step 2 failed:', err.message);
    throw err;
  }

  // ─── Step 3: Final composition — overlay + sticker + shake + audio ────────
  console.log('Step 3: Final composition...');
  try {
    const hasAudio    = fs.existsSync(AUDIO_FILE);
    const audioInput  = hasAudio ? `-stream_loop -1 -i "${AUDIO_FILE}"` : '';
    const audioMap    = hasAudio ? `-map [out_a] -c:a aac -b:a 128k` : '';
    const audioFilter = hasAudio ? `;[3:a]anull[out_a]` : '';

    // Note: audio bitrate reduced 192k→128k to save encode RAM
    ff(`${FFMPEG} -threads ${T}` +
       ` -i "${OUTPUT_DIR}/extended-main.mp4"` +
       ` -i "${OUTPUT_DIR}/middle-curtain.mp4"` +
       ` -i "${STICKER}"` +
       ` ${audioInput}` +
       ` -filter_complex "` +
         `[0:v]format=yuv420p,fps=60,scale=1080:1920:sws_flags=fast_bilinear[v0];` +
         `[1:v]format=yuv420p,setpts=PTS+${mainDur}/TB,fps=60,scale=1080:1920:sws_flags=fast_bilinear[mid];` +
         `[2:v]format=yuv420p,loop=-1:1,setpts=PTS+${mainDur}/TB,fps=60,` +
           `scale='trunc(iw*max(0.6,1-pow(sin((t-${mainDur})/(${total}-${mainDur})*1.5708),2)*0.4)/2)*2` +
              `:trunc(ih*max(0.6,1-pow(sin((t-${mainDur})/(${total}-${mainDur})*1.5708),2)*0.4)/2)*2':eval=frame:sws_flags=fast_bilinear[sticker];` +
         `[v0][mid]overlay=0:0:shortest=1[tmp];` +
         `[tmp][sticker]overlay=(W-w)/2:H-h:shortest=1[comp];` +
         `[comp]crop=iw-40:ih-40:20+15*sin(t*7):20+15*cos(t*9)[shake];` +
         `[shake]scale=1080:1920:sws_flags=fast_bilinear,format=yuv420p[out_v]${audioFilter}"` +
       ` -map [out_v] ${audioMap}` +
       ` -c:v libx264 -preset ${P} -pix_fmt yuv420p -threads ${T} -bufsize 8M -r 60 -t ${total}` +
       ` "${OUTPUT}" -y`);

    console.log('\n✅ Done!');
    console.log(`🎉 ${OUTPUT}`);
  } catch (err) {
    console.error('❌ Step 3 failed:', err.message);
    throw err;
  }
}

main();
