# Multi-stage: Node app + Playwright Chromium + sing-box
# linux/amd64 + linux/arm64 (Oracle A1)

FROM node:20-bookworm AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0
# Install chromium + OS deps into /ms-playwright (explicit path)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright \
  && npx playwright install --with-deps chromium \
  && chmod -R a+rX /ms-playwright

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
  curl -fsSL "$url" -o /tmp/sb.tgz; \
  tar -xzf /tmp/sb.tgz -C /tmp; \
  find /tmp -name 'sing-box' -type f -exec cp {} /opt/sing-box/sing-box \; ; \
  chmod 755 /opt/sing-box/sing-box; \
  rm -rf /tmp/sb.tgz /tmp/sing-box-*

FROM node:20-bookworm AS runtime
WORKDIR /app

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
    libxfixes3 \
    libxkbcommon0 \
    libpango-1.0-0 \
    libcairo2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/longcat2api /tmp /opt/sing-box /ms-playwright \
    && chown -R node:node /var/lib/longcat2api /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /ms-playwright /ms-playwright
COPY --from=deps /opt/sing-box/sing-box /opt/sing-box/sing-box
RUN chmod -R a+rX /ms-playwright \
  && chmod 755 /opt/sing-box/sing-box \
  && chown -R node:node /ms-playwright

COPY package.json ./
COPY src ./src
COPY public ./public
COPY config.example.json ./config.example.json
COPY docs ./docs
RUN chown -R node:node /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/var/lib/longcat2api \
    CONFIG_PATH=/var/lib/longcat2api/config.json \
    SQLITE_PATH=/var/lib/longcat2api/longcat2api.db \
    HOME=/tmp \
    TMPDIR=/tmp \
    TEMP=/tmp \
    TMP=/tmp \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_ARTIFACTS_DIR=/tmp/playwright-artifacts \
    LONGCAT2API_REGISTER_HEADLESS=1 \
    LONGCAT2API_PROXY_SINGBOX_PATH=/opt/sing-box/sing-box

USER node
EXPOSE 8080
VOLUME ["/var/lib/longcat2api"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
