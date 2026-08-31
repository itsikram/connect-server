# Connect Server — one container for Render and local Docker.
# Render injects PORT. The CPU load balancer binds that port and
# proxies /api to the lowest-CPU Node worker (internal 4001+).
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
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Deno (yt-dlp recommended JS runtime for YouTube EJS challenges)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && deno --version

COPY package*.json ./
COPY scripts/install-yt-dlp.js scripts/postinstall.js ./scripts/

RUN npm ci --only=production

COPY . .

ENV YT_DLP_FORCE_UPDATE=true
RUN node scripts/install-yt-dlp.js || true

RUN mkdir -p /var/log/nginx

# Public port for local docker. Render overwrites PORT at runtime.
ENV NODE_ENV=production \
    PORT=4000 \
    LB_BACKENDS=2 \
    LB_BACKEND_START_PORT=4001

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD node -e "const p=process.env.PORT||4000; require('http').get('http://127.0.0.1:'+p+'/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "load-balancer/start-cluster.js"]
