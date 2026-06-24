FROM node:20-bookworm-slim

# Install system dependencies: ffmpeg, unzip, and HEIC support libs
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

# Use npm ci for reproducible, clean installs (uses package-lock.json)
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Create required runtime directories
RUN mkdir -p temp-requests output

# Expose port (Railway injects $PORT dynamically)
EXPOSE 3005

# Health check so Railway knows when the app is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3005) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
