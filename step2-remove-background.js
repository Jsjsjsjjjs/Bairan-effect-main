const fs = require('fs');
const path = require('path');
const removeBackground = require('@imgly/background-removal-node').removeBackground;

const workDir = process.argv[2] || '.';
const OUTPUT_DIR = path.join(workDir, 'output');
const INPUT_IMAGE = path.join(OUTPUT_DIR, 'last-frame.png');
const BG_REMOVED_IMAGE = path.join(OUTPUT_DIR, 'bg-removed.png');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function removeBackgroundLocal(imagePath) {
  console.log('Removing background locally using @imgly/background-removal-node...');
  console.log(`Input image path: ${imagePath}`);
  
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Input image not found: ${imagePath}`);
  }

  try {
    const config = {
      model: "small", // Using small model to save memory/disk
    };

    console.log('Processing image (this may take a moment on first run)...');
    const blob = await removeBackground(imagePath, config);
    
    console.log('Processing complete! Converting blob to buffer...');
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    fs.writeFileSync(BG_REMOVED_IMAGE, buffer);
    
    console.log(`✅ Background removed successfully!`);
    console.log(`📁 Saved to: ${BG_REMOVED_IMAGE}`);
    
    return BG_REMOVED_IMAGE;
  } catch (error) {
    console.error('❌ Background removal failed!');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    if (error.stack) console.error('Stack trace:', error.stack);
    throw error;
  }
}

console.log('🎨 Step 2: Removing background from last frame (LOCAL)...');
console.log(`WorkDir: ${workDir}`);

removeBackgroundLocal(INPUT_IMAGE)
  .then(() => {
    console.log('\n✨ Step 2 complete!');
    console.log(`Next: Add thick white borders to ${BG_REMOVED_IMAGE}`);
  })
  .catch((err) => {
    console.error('❌ Step 2 failed:', err.message);
    console.error(err);
    process.exit(1);
  });
