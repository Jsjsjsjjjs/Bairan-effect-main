const fs = require('fs');
const path = require('path');
const { removeBackground } = require('@imgly/background-removal-node');

const workDir = process.argv[2] || '.';
const OUTPUT_DIR = path.join(workDir, 'output');
const INPUT_IMAGE = path.join(OUTPUT_DIR, 'last-frame.png');
const BG_REMOVED_IMAGE = path.join(OUTPUT_DIR, 'bg-removed.png');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function removeBackgroundLocal(imagePath) {
  console.log('🎨 Removing background using @imgly/background-removal-node...');
  console.log(`Input: ${imagePath}`);

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Input image not found: ${imagePath}`);
  }

  // ─── FIX: @imgly/background-removal-node does NOT accept Windows C:\ paths ─
  // Convert the absolute path to a proper file:// URL which works on all OSes.
  // On Windows: C:\Users\... → file:///C:/Users/...
  // On Linux:   /app/...    → file:///app/...
  const fileUrl = new URL(`file:///${imagePath.replace(/\\/g, '/')}`).href;
  console.log(`File URL: ${fileUrl}`);

  try {
    const config = {
      model: 'small', // smallest model = fastest + least RAM
      output: {
        format: 'image/png',
        quality: 1,
      },
    };

    console.log('Processing image (first run downloads AI model ~45MB)...');
    const blob = await removeBackground(fileUrl, config);

    console.log('✅ Background removed. Saving...');
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(BG_REMOVED_IMAGE, buffer);

    console.log(`📁 Saved to: ${BG_REMOVED_IMAGE}`);
    return BG_REMOVED_IMAGE;
  } catch (error) {
    console.error('❌ Background removal failed!');
    console.error('Error:', error.message);
    if (error.stack) console.error(error.stack);
    throw error;
  }
}

console.log('🎨 Step 2: Removing background from last frame...');
console.log(`WorkDir: ${workDir}`);

removeBackgroundLocal(INPUT_IMAGE)
  .then(() => {
    console.log('\n✨ Step 2 complete!');
  })
  .catch((err) => {
    console.error('❌ Step 2 failed:', err.message);
    process.exit(1);
  });
