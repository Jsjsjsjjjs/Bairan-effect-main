const express = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const FormData = require('form-data');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public')); // Serve frontend

const FFMPEG = 'ffmpeg';

// ── Use absolute paths so they work regardless of process CWD ──────────────
const TEMP_BASE_DIR = path.join(__dirname, 'temp-requests');
const GLOBAL_OUTPUT_DIR = path.join(__dirname, 'output');

let isProcessing = false; // Simple lock for sequential processing to avoid OOM in cloud
const processingQueue = [];
const taskStatus = new Map(); // Store status of each requestId

// Create required directories on startup
if (!fs.existsSync(TEMP_BASE_DIR))    fs.mkdirSync(TEMP_BASE_DIR,    { recursive: true });
if (!fs.existsSync(GLOBAL_OUTPUT_DIR)) fs.mkdirSync(GLOBAL_OUTPUT_DIR, { recursive: true });

// ── Auto-cleanup old requests every 30 minutes ─────────────────────────────
setInterval(() => {
  console.log('🧹 Running auto-cleanup of old temporary requests...');
  try {
    const folders = fs.readdirSync(TEMP_BASE_DIR);
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour

    folders.forEach(folder => {
      const folderPath = path.join(TEMP_BASE_DIR, folder);
      try {
        const stats = fs.statSync(folderPath);
        if (now - stats.mtimeMs > maxAge) {
          console.log(`🗑️ Deleting expired request folder: ${folder}`);
          fs.rmSync(folderPath, { recursive: true, force: true });
        }
      } catch (statErr) {
        // Folder may have already been deleted; skip silently
      }
    });
  } catch (err) {
    console.error('❌ Cleanup failed:', err.message);
  }
}, 30 * 60 * 1000);

// ── Auto-cleanup taskStatus Map to prevent memory leak ─────────────────────
setInterval(() => {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours
  for (const [id, status] of taskStatus.entries()) {
    if (status._timestamp && now - status._timestamp > maxAge) {
      taskStatus.delete(id);
    }
  }
}, 30 * 60 * 1000);

// ── Configure multer for file uploads ──────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!req.requestId) {
      req.requestId = generateRequestId();
      console.log(`Debug: Generated NEW requestId: ${req.requestId}`);
    } else {
      console.log(`Debug: Reusing requestId: ${req.requestId} for file ${file.originalname}`);
    }
    const workDir = path.join(TEMP_BASE_DIR, req.requestId);
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

    if (file.fieldname === 'video') {
      cb(null, workDir);
    } else {
      const imagesDir = path.join(workDir, 'middle-images');
      if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
      cb(null, imagesDir);
    }
  },
  filename: (req, file, cb) => {
    if (file.fieldname === 'video') {
      cb(null, 'input-video' + path.extname(file.originalname));
    } else {
      cb(null, file.originalname);
    }
  }
});

const upload = multer({ storage: storage });

// ── Download a file from a URL, following redirects ────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);

    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Close the current write stream before following redirect
        file.close(() => {
          downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        });
        return;
      }
      if (response.statusCode !== 200) {
        file.close(() => fs.unlink(dest, () => {}));
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close(() => fs.unlink(dest, () => {}));
      reject(err);
    });
  });
}

function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function uploadToStoreFile(filePath, userId) {
  let url = process.env.STORAGE_URL;
  if (!url || url === '{api_url/store-file}') {
    console.warn('STORAGE_URL not set. Using local fallback.');
    return { fileUrl: `/download/${path.basename(filePath)}`, fileId: 'local' };
  }

  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('userid', userId);

    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'POST',
      headers: form.getHeaders()
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        } else {
          reject(new Error(`Upload failed with status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    form.pipe(req);
  });
}

function extractZip(zipPath, destDir) {
  console.log(`Extracting zip: ${zipPath}`);
  execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'inherit' });
  const files = fs.readdirSync(destDir);
  console.log(`Extracted ${files.length} files`);
}

// ── Run a processing step as a child node process ─────────────────────────
function runStep(stepNum, workDir) {
  return new Promise((resolve, reject) => {
    const scriptMap = {
      1: 'step1-extract-last-frame.js',
      2: 'step2-remove-background.js',
      3: 'step3-add-borders.js',
      4: 'step4-compose-video.js'
    };
    const scriptName = scriptMap[stepNum];
    if (!scriptName) return reject(new Error(`Unknown step: ${stepNum}`));

    console.log(`Running step ${stepNum}: ${scriptName}`);

    const proc = spawn('node', [scriptName, workDir], {
      cwd: __dirname,
      stdio: 'inherit'
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start step ${stepNum}: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Step ${stepNum} failed with exit code ${code}`));
    });
  });
}

// ── Core video processing pipeline ────────────────────────────────────────
async function processVideo(videoPath, isUrl = false, zipPath = null, zipUrl = false, userId = null, imageUrls = null, existingWorkDir = null) {
  const requestId = existingWorkDir ? path.basename(existingWorkDir) : generateRequestId();
  const effectiveUserId = userId || requestId;
  const workDir = existingWorkDir || path.join(TEMP_BASE_DIR, requestId);
  const imagesDir = path.join(workDir, 'middle-images');
  const outputDir = path.join(workDir, 'output');

  // Ensure directories exist
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Work directory: ${workDir}`);

  try {
    const tempZip = path.join(workDir, 'input-images.zip');
    const middleSlideshow = path.join(outputDir, 'middle-slideshow.mp4');

    // ── Slideshow creation from images ────────────────────────────────────
    if (zipPath) {
      if (zipUrl) {
        console.log(`Downloading zip from: ${zipPath}`);
        await downloadFile(zipPath, tempZip);
        zipPath = tempZip;
      }
      if (!fs.existsSync(zipPath)) throw new Error(`Zip file not found: ${zipPath}`);
      console.log(`Extracting images from zip: ${zipPath}`);
      extractZip(zipPath, imagesDir);
      if (zipUrl && fs.existsSync(tempZip)) fs.unlinkSync(tempZip);

      console.log('Creating slideshow from zip images...');
      await spawnSlideshow(imagesDir, middleSlideshow);

    } else if (imageUrls && imageUrls.length > 0) {
      console.log(`Downloading ${imageUrls.length} images...`);
      for (let i = 0; i < imageUrls.length; i++) {
        const imageUrl = imageUrls[i];
        const ext = path.extname(new URL(imageUrl).pathname).split('?')[0] || '.jpg';
        const destPath = path.join(imagesDir, `image_${String(i).padStart(3, '0')}${ext}`);
        console.log(`Downloading image ${i + 1}/${imageUrls.length}: ${imageUrl}`);
        await downloadFile(imageUrl, destPath);
      }
      console.log('Creating slideshow from downloaded images...');
      await spawnSlideshow(imagesDir, middleSlideshow);

    } else {
      // Images already uploaded via multer
      const uploadedImages = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir) : [];
      if (uploadedImages.length > 0) {
        console.log(`Using ${uploadedImages.length} uploaded images for slideshow...`);
        await spawnSlideshow(imagesDir, middleSlideshow);
      }
    }

    // ── Video discovery / download ─────────────────────────────────────────
    const tempVideo = path.join(workDir, 'input-video.mp4');

    if (isUrl) {
      console.log(`Downloading video from: ${videoPath}`);
      await downloadFile(videoPath, tempVideo);
      videoPath = tempVideo;
    } else if (existingWorkDir) {
      // Find whichever video file multer saved
      const files = fs.readdirSync(workDir);
      console.log(`Debug: Files in workDir ${requestId}:`, files);
      const videoFile = files.find(f => f.startsWith('input-video'));
      if (videoFile) {
        videoPath = path.join(workDir, videoFile);
        console.log(`Debug: Found video at ${videoPath}`);
      } else {
        throw new Error('No uploaded video found in work directory');
      }
    } else {
      if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
    }

    console.log(`Processing: ${videoPath}`);

    const ext = path.extname(videoPath).toLowerCase();
    if (!['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
      throw new Error('Unsupported video format. Use MP4, MOV, AVI, MKV, or WebM.');
    }

    // ── Normalize video to MP4 ─────────────────────────────────────────────
    const mainVideo = path.join(workDir, 'main-video.MP4');
    console.log(`Converting to MP4: ${videoPath}`);
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i', videoPath,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-y',
        mainVideo
      ], { stdio: 'inherit' });
      proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
      proc.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Converted to MP4: ${mainVideo}`);
          resolve();
        } else {
          reject(new Error(`Video conversion failed with code ${code}`));
        }
      });
    });

    // ── Run processing pipeline ────────────────────────────────────────────
    await runStep(1, workDir); // Extract last frame
    await runStep(2, workDir); // Remove background
    await runStep(3, workDir); // Add sticker borders
    await runStep(4, workDir); // Compose final video

    // ── Copy to global output for download ────────────────────────────────
    const finalVideo = path.join(outputDir, 'final-video.mp4');
    if (!fs.existsSync(finalVideo)) throw new Error('Final video not produced by step4');

    const downloadFilename = `final_${requestId}.mp4`;
    const downloadPath = path.join(GLOBAL_OUTPUT_DIR, downloadFilename);
    fs.copyFileSync(finalVideo, downloadPath);

    console.log('Uploading/Readying final video...');
    const uploadResult = await uploadToStoreFile(finalVideo, effectiveUserId);

    // Cleanup work directory
    fs.rmSync(workDir, { recursive: true, force: true });
    console.log(`✅ Cleaned up work directory: ${requestId}`);

    return {
      success: true,
      fileUrl: uploadResult.fileUrl,
      downloadUrl: `/download/${downloadFilename}`,
      requestId: requestId
    };

  } catch (error) {
    console.error('❌ Error:', error.message);
    // Work dir left intentionally for debugging; cleaned by auto-cleanup after 1 hour
    throw error;
  }
}

// ── Helper: spawn slideshow creation process ──────────────────────────────
function spawnSlideshow(imagesDir, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['create-middle-slideshow.js', imagesDir, outputPath], {
      cwd: __dirname,
      stdio: 'inherit'
    });
    proc.on('error', (err) => reject(new Error(`Failed to start slideshow process: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Slideshow creation failed with exit code ${code}`));
    });
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────

// JSON body API (for URL-based inputs)
app.post('/process', async (req, res) => {
  try {
    const { videoPath, isUrl, zipPath, zipUrl, userId, imageUrls } = req.body;
    if (!videoPath) return res.status(400).json({ error: 'videoPath is required' });
    const result = await processVideo(videoPath, isUrl, zipPath, zipUrl, userId, imageUrls);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Multipart file upload + async processing with status polling
app.post('/upload-and-process', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'photos', maxCount: 100 }
]), async (req, res) => {
  const requestId = req.requestId;
  if (!requestId) return res.status(400).json({ error: 'No files uploaded' });

  const workDir = path.join(TEMP_BASE_DIR, requestId);

  // Initialize task status with timestamp for cleanup
  taskStatus.set(requestId, { status: 'queued', progress: 0, _timestamp: Date.now() });

  const processTask = async () => {
    try {
      taskStatus.set(requestId, { status: 'processing', progress: 10, _timestamp: Date.now() });
      console.log(`🚀 Starting processing for ${requestId}...`);
      const result = await processVideo(null, false, null, false, null, null, workDir);
      taskStatus.set(requestId, { status: 'completed', result, _timestamp: Date.now() });
      return result;
    } catch (error) {
      console.error(`❌ Error processing ${requestId}:`, error.message);
      taskStatus.set(requestId, { status: 'failed', error: error.message, _timestamp: Date.now() });
      throw error;
    }
  };

  // Sequential queue runner
  const runNextTask = async () => {
    if (isProcessing || processingQueue.length === 0) return;
    isProcessing = true;
    const { task, resolve, reject } = processingQueue.shift();
    try {
      const result = await task();
      resolve(result);
    } catch (e) {
      reject(e);
    } finally {
      isProcessing = false;
      runNextTask();
    }
  };

  processingQueue.push({
    task: processTask,
    resolve: () => console.log(`✅ ${requestId} done`),
    reject: (e) => console.log(`❌ ${requestId} failed: ${e.message}`)
  });
  runNextTask();

  // Respond immediately; client polls /status/:requestId
  res.json({ success: true, requestId, status: 'queued' });
});

// Task status polling
app.get('/status/:requestId', (req, res) => {
  const { requestId } = req.params;
  const status = taskStatus.get(requestId);
  if (!status) return res.status(404).json({ error: 'Task not found' });
  // Strip internal _timestamp from response
  const { _timestamp, ...publicStatus } = status;
  res.json(publicStatus);
});

// File download
app.get('/download/:filename', (req, res) => {
  // Sanitize filename to prevent path traversal
  const filename = path.basename(req.params.filename);
  const filePath = path.join(GLOBAL_OUTPUT_DIR, filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Server status
app.get('/status', (req, res) => {
  res.json({ status: 'running', queued: processingQueue.length, processing: isProcessing });
});

// Health check for Railway / Docker
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Global error handler (catches multer errors + unhandled throws)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('❌ Multer Error:', err.message, 'Code:', err.code);
    return res.status(400).json({ success: false, error: `Upload error: ${err.message}. (Max 100 photos)` });
  }
  console.error('❌ Unhandled Server Error:', err.stack);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

// ── Server startup ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3005;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Graceful shutdown for Railway / Docker SIGTERM
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('✅ HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
