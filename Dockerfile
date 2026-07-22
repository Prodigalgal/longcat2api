# Multi-stage: Node app + Playwright Chromium for full-auto mykeeta register
# Targets: linux/amd64, linux/arm64 (Oracle A1)

FROM node:20-bookworm AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# Install deps without postinstall first, then playwright chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0
RUN npx playwright install --with-deps chromium

# Optional: pre-fetch sing-box for proxy pool (best-effort)
ARG SING_BOX_VERSION=1.11.7
RUN set -eux; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64|amd64) sb_arch=amd64 ;; \
    aarch64|arm64) sb_arch=arm64 ;; \
    *) sb_arch=amd64 ;; \
  esac; \
  mkdir -p /opt/sing-box; \
  url="https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-${sb_arch}.tar.gz"; \
  curl -fsSL "$url" -o /tmp/sb.tgz || exit 0; \
  tar -xzf /tmp/sb.tgz -C /tmp; \
  find /tmp -name 'sing-box' -type f -exec cp {} /opt/sing-box/sing-box \; ; \
  chmod +x /opt/sing-box/sing-box || true; \
  rm -rf /tmp/sb.tgz /tmp/sing-box-*

FROM node:20-bookworm AS runtime
WORKDIR /app

# Chromium runtime libs (playwright --with-deps already on deps; reinstall minimal for runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/longcat2api /tmp/longcat2api /opt/sing-box \
    && chown -R node:node /var/lib/longcat2api /tmp/longcat2api /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /root/.cache/ms-playwright /ms-playwright
COPY --from=deps /opt/sing-box /opt/sing-box
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config.example.json ./config.example.json
COPY docs ./docs

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/var/lib/longcat2api \
    CONFIG_PATH=/var/lib/longcat2api/config.json \
    SQLITE_PATH=/var/lib/longcat2api/longcat2api.db \
    TMPDIR=/tmp/longcat2api \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    LONGCAT2API_REGISTER_HEADLESS=1 \
    LONGCAT2API_PROXY_SINGBOX_PATH=/opt/sing-box/sing-box

# Chromium needs writable home /tmp; run as node with no-sandbox in app
USER node
EXPOSE 8080
VOLUME ["/var/lib/longcat2api"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
