import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config, paths } from './config.js';
import {
  closeDb,
  failInterruptedRegisterJobs,
  initDb,
  sanitizeStoredRegisterJobLogs,
} from './db/index.js';
import openaiRoutes from './routes/openai.js';
import adminRoutes from './routes/admin.js';
import { requireAdmin } from './middleware/auth.js';
import { startKeepaliveLoop, stopKeepaliveLoop } from './services/keepalive.js';
import { reclaimProxy } from './services/proxyPool.js';
import { accountCoordinator } from './services/accountCoordinator.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

// init — force writable tmp under K8s readOnlyRootFilesystem
// (emptyDir is mounted at /tmp; never nest under missing /tmp/longcat2api)
process.env.TMPDIR = process.env.TMPDIR || '/tmp';
process.env.TEMP = process.env.TEMP || '/tmp';
process.env.TMP = process.env.TMP || '/tmp';
process.env.HOME = process.env.HOME || '/tmp';
// Camoufox + Patchright paths (no stock Playwright)
process.env.CAMOUFOX_INSTALL_DIR =
  process.env.CAMOUFOX_INSTALL_DIR || path.join(process.env.HOME || '/tmp', '.cache', 'camoufox');
process.env.PLAYWRIGHT_BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';

for (const d of [
  paths.data,
  process.env.TMPDIR,
  process.env.CAMOUFOX_INSTALL_DIR,
  path.join(process.env.HOME || '/tmp', '.cache'),
]) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    console.warn('[startup] mkdir', d, e.message);
  }
}
initDb();
const sanitizedRegisterJobs = sanitizeStoredRegisterJobLogs();
if (sanitizedRegisterJobs) {
  console.log(`[startup] sanitized logs for ${sanitizedRegisterJobs} register job(s)`);
}
const interruptedRegisterJobs = failInterruptedRegisterJobs();
if (interruptedRegisterJobs) {
  console.warn(`[startup] marked ${interruptedRegisterJobs} interrupted register job(s) as error`);
}
config.load();

// Register readiness (logged once)
try {
  const cam = process.env.CAMOUFOX_INSTALL_DIR;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const sb =
    process.env.LONGCAT2API_PROXY_SINGBOX_PATH ||
    process.env.SING_BOX_PATH ||
    '/opt/sing-box/sing-box';
  console.log(
    `[startup] register: engine=${process.env.LONGCAT2API_BROWSER_ENGINE || 'camoufox'} camoufox=${cam} exists=${fs.existsSync(cam || '')} patchright_path=${pw} exists=${!!(pw && fs.existsSync(pw))} singbox=${sb} exists=${fs.existsSync(sb)} tmp=${process.env.TMPDIR}`
  );
} catch {
  /* ignore */
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', async (_req, res) => {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
  const camoufoxDir = process.env.CAMOUFOX_INSTALL_DIR || '';
  const singbox =
    process.env.LONGCAT2API_PROXY_SINGBOX_PATH ||
    process.env.SING_BOX_PATH ||
    '/opt/sing-box/sing-box';
  let chromiumOk = false;
  try {
    if (fs.existsSync(browsersPath)) {
      const walk = (dir, depth = 0) => {
        if (depth > 4 || chromiumOk) return;
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          let st;
          try {
            st = fs.statSync(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) walk(p, depth + 1);
          else if (/chrome$|chromium$|chrome-headless-shell$/i.test(name)) chromiumOk = true;
        }
      };
      walk(browsersPath);
    }
  } catch {
    /* ignore */
  }
  let browserMeta = null;
  try {
    const { browserStatus } = await import('./services/browser.js');
    browserMeta = await browserStatus();
  } catch (e) {
    browserMeta = { error: e.message };
  }
  res.json({
    status: 'ok',
    service: 'longcat2api',
    version: '1.0.2',
    mode: config.getDefaultMode(),
    runtime: 'nodejs',
    sqlite: paths.sqlite,
    register: {
      browser_engine: process.env.LONGCAT2API_BROWSER_ENGINE || 'camoufox',
      camoufox_install_dir: camoufoxDir,
      camoufox_exists: !!(camoufoxDir && fs.existsSync(camoufoxDir)),
      patchright_browsers_path: browsersPath,
      chromium_detected: chromiumOk,
      backends: browserMeta,
      singbox_path: singbox,
      singbox_exists: fs.existsSync(singbox),
      tmpdir: process.env.TMPDIR || '/tmp',
    },
  });
});

// Public OpenAI-compatible API (+ /health above). No Basic admin here.
app.use(openaiRoutes);

// Admin API: HTTP Basic (username fixed: admin)
app.use(adminRoutes);

// Admin panel: same Basic challenge once in the browser — no SPA re-login.
const publicDir = paths.public;
if (fs.existsSync(publicDir)) {
  app.use((req, res, next) => {
    // Only gate HTML/static UI; APIs already handled above.
    if (req.path.startsWith('/api') || req.path.startsWith('/v1') || req.path === '/health') {
      return next();
    }
    return requireAdmin(req, res, next);
  });
  app.use(express.static(publicDir, { index: 'index.html' }));
  app.get(['/', '/admin', '/admin/*'], requireAdmin, (_req, res) => {
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
⚙  mode: session-only (Cookie accounts required)
`);
  startKeepaliveLoop();
});

function shutdown() {
  console.log('\n[shutdown] ...');
  stopKeepaliveLoop();
  accountCoordinator.close();
  try {
    reclaimProxy();
  } catch {
    /* ignore */
  }
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
