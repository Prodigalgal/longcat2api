# Multi-stage build for Oracle Cloud K8s (linux/amd64 + linux/arm64)
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 app \
    && useradd -u 10001 -g app -d /app -s /sbin/nologin app \
    && mkdir -p /var/lib/longcat2api /tmp/longcat2api \
    && chown -R app:app /var/lib/longcat2api /tmp/longcat2api /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config.example.json ./config.example.json

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/var/lib/longcat2api \
    CONFIG_PATH=/var/lib/longcat2api/config.json \
    SQLITE_PATH=/var/lib/longcat2api/longcat2api.db \
    TMPDIR=/tmp/longcat2api

USER 10001:10001
EXPOSE 8080
VOLUME ["/var/lib/longcat2api"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
