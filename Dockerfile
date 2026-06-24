FROM node:20-bookworm-slim

# Install system dependencies: ffmpeg, unzip, HEIC support
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    unzip \
    libheif-dev \
    libde265-0 \
    libheif1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package*.json ./

# Reproducible install, production deps only
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Create required runtime directories with correct permissions
RUN mkdir -p temp-requests output && chmod 777 temp-requests output

# Expose port (Railway injects $PORT dynamically)
EXPOSE 3005

# Health check — start-period gives time for @imgly model download on first boot
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=5 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3005) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Limit Node.js heap to leave RAM for ffmpeg subprocess
# Railway Starter = 512MB total → Node heap 256MB, ffmpeg gets the rest
ENV NODE_OPTIONS="--max-old-space-size=256"

CMD ["node", "server.js"]
