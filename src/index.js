import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config, paths } from './config.js';
import { initDb } from './db/index.js';
import openaiRoutes from './routes/openai.js';
import adminRoutes from './routes/admin.js';
import { startKeepaliveLoop, stopKeepaliveLoop } from './services/keepalive.js';
import { reclaimProxy } from './services/proxyPool.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

// init
fs.mkdirSync(paths.data, { recursive: true });
initDb();
config.load();

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'longcat2api',
    version: '1.0.0',
    mode: config.getDefaultMode(),
    runtime: 'nodejs',
    sqlite: paths.sqlite,
  });
});

app.use(openaiRoutes);
app.use(adminRoutes);

// static admin UI
const publicDir = paths.public;
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get(['/', '/admin', '/admin/*'], (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: { message: err.message || 'internal error' } });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                    longcat2api (Node.js)                 ║
║     LongCat Web → OpenAI chat/responses · SQLite         ║
╚══════════════════════════════════════════════════════════╝

🚀 http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}
📡 POST /v1/chat/completions
📡 POST /v1/responses
📋 GET  /v1/models
🛠  Admin UI: http://localhost:${PORT}/  (Basic admin / <admin_password>)
💾 SQLite: ${paths.sqlite}
⚙  mode: ${config.getDefaultMode()}
`);
  startKeepaliveLoop();
});

function shutdown() {
  console.log('\n[shutdown] ...');
  stopKeepaliveLoop();
  try {
    reclaimProxy();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
