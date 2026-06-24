const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const workDir = process.argv[2] || '.';
const OUTPUT_DIR = path.join(workDir, 'output');
const INPUT_IMAGE = path.join(OUTPUT_DIR, 'bg-removed.png');
const BORDERED_IMAGE = path.join(OUTPUT_DIR, 'bordered-image.png');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Border configuration - PROFESSIONAL STICKER EFFECT
// Order: Subject → White (inner)
const WHITE_INNER_THICKNESS = 4; // Increased for a bolder, cleaner look
const BLACK_THICKNESS = 0;
const WHITE_OUTER_THICKNESS = 0;

async function createStickerEffect(imagePath, outputPath) {
  console.log('Creating professional sticker effect with multiple borders...');
  console.log(`Input: ${imagePath}`);
  console.log(`Border layers: White(${WHITE_INNER_THICKNESS}) → Black(${BLACK_THICKNESS}) → White(${WHITE_OUTER_THICKNESS})`);
  
  try {
    // Load the image
    const image = sharp(imagePath);
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;
    
    console.log(`Image size: ${width}x${height}`);
    
    // Get the raw pixel data
    const { data, info } = await image.raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    
    console.log('Creating border layers...');
    
    // Create the three border layers
    const outerWhiteLayer = createBorderLayer(data, info.width, info.height, 
      WHITE_INNER_THICKNESS + BLACK_THICKNESS + WHITE_OUTER_THICKNESS, 255, 255, 255);
    
    const blackLayer = createBorderLayer(data, info.width, info.height, 
      WHITE_INNER_THICKNESS + BLACK_THICKNESS, 0, 0, 0);
    
    const innerWhiteLayer = createBorderLayer(data, info.width, info.height, 
      WHITE_INNER_THICKNESS, 255, 255, 255);
    
    console.log('Compositing layers (bottom to top)...');
    
    // 1. Composite borders
    // 2. Anti-alias (blur) the combined borders
    // 3. Place original crisp subject on top
    
    const bordersOnly = await sharp(outerWhiteLayer, { raw: { width, height, channels: 4 } })
      .composite([
        { input: blackLayer, raw: { width, height, channels: 4 }, blend: 'over' },
        { input: innerWhiteLayer, raw: { width, height, channels: 4 }, blend: 'over' }
      ])
      .png()
      .toBuffer();

    const result = await sharp(bordersOnly)
      .blur(1.5) // Anti-alias the jagged dilation edges
      .composite([
        { input: data, raw: { width, height, channels: 4 }, blend: 'over' }
      ])
      .png()
      .toFile(outputPath);
    
    console.log(`✅ Professional sticker effect created successfully!`);
    console.log(`📁 Saved to: ${outputPath}`);
    
    return outputPath;
  } catch (error) {
    console.error('❌ Error creating sticker effect:', error.message);
    console.error(error);
    throw error;
  }
}

function createBorderLayer(rgbaBuffer, width, height, thickness, r, g, b) {
  // Create a new buffer for the border layer
  const layer = Buffer.alloc(width * height * 4);
  
  // Extract alpha channel and create dilated version
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = rgbaBuffer[idx + 3];
      
      if (alpha > 0) {
        // Mark this pixel and surrounding pixels based on thickness
        for (let dy = -thickness; dy <= thickness; dy++) {
          for (let dx = -thickness; dx <= thickness; dx++) {
            // Circle-shaped dilation (more natural)
            if (dx * dx + dy * dy <= thickness * thickness) {
              const ny = y + dy;
              const nx = x + dx;
              
              if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                const nIdx = (ny * width + nx) * 4;
                layer[nIdx] = r;
                layer[nIdx + 1] = g;
                layer[nIdx + 2] = b;
                layer[nIdx + 3] = 255;
              }
            }
          }
        }
      }
    }
  }
  
  return layer;
}

console.log('🖼️  Step 3: Creating professional sticker with multi-layer borders...');
console.log(`WorkDir: ${workDir}`);

createStickerEffect(INPUT_IMAGE, BORDERED_IMAGE)
  .then(() => {
    console.log('\n✨ Step 3 complete!');
    console.log(`Next: Layer videos with ${BORDERED_IMAGE} on top`);
  })
  .catch((err) => {
    console.error('❌ Step 3 failed:', err.message);
    console.error(err);
    process.exit(1);
  });
