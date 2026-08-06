# Dockerfile for Connect Server
# Node 22+ required: yt-dlp needs a JS runtime to extract YouTube formats
FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    make \
    g++ \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Deno (yt-dlp recommended JS runtime for YouTube EJS challenges)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && deno --version

# Standalone yt-dlp binary is installed later via scripts/install-yt-dlp.js
# (pip install is blocked on Debian bookworm / PEP 668)

COPY package*.json ./
COPY scripts/install-yt-dlp.js scripts/postinstall.js ./scripts/

RUN npm ci --only=production

COPY . .

ENV YT_DLP_FORCE_UPDATE=true
RUN node scripts/install-yt-dlp.js || true

RUN mkdir -p /var/log/nginx

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "index.js"]
