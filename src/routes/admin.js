import { Router } from 'express';
import { config } from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  listAccounts,
  getAccount,
  updateAccount,
  deleteAccount,
  sanitizeAccount,
  getUsage,
  listRequestLogs,
  getRegisterJob,
} from '../db/index.js';
import {
  importCookieAccount,
  prepareRegisterMailbox,
  runOneRegisterAttempt,
  bindCookieToAccount,
  startBatchRegisterJob,
  parseCookieString,
} from '../services/register.js';
import {
  testConnection,
  isTempMailConfigured,
  listDomains,
} from '../services/tempMail.js';
import {
  configureProxyPool,
  proxyStatus,
  startProxy,
  stopProxy,
  rotateProxy,
  testProxyConnectivity,
  fetchNodes,
} from '../services/proxyPool.js';
import { probeAccount } from '../services/longcatClient.js';
import { renewAll, renewOneAccount } from '../services/keepalive.js';
import { summarizeFlow, buildLoginPageUrl, MYKEETA } from '../services/mykeetaClient.js';

const router = Router();

router.use(requireAdmin);

// ─── protocol cheat-sheet (oversea email → chat → keepalive) ─

router.get('/api/protocol/summary', (_req, res) => {
  res.json({
    ok: true,
    oversea_passport: MYKEETA.origin,
    mykeeta_login_url: buildLoginPageUrl(),
    flow: summarizeFlow(),
    chat: {
      oversea: {
        url: 'https://longcat.chat/api/v1/chat-completion-oversea-V2',
        cookie: false,
      },
      logged_in: {
        session: 'https://longcat.chat/api/v1/session-create',
        chat: 'https://longcat.chat/api/v1/chat-completion-V2',
        cookie: 'passport_token_key required',
      },
      flags: {
        reasonEnabled: '0|1 (thinking on/off, no multi-level effort)',
        searchEnabled: '0|1 (web search on/off)',
        agentId: '1 default, 2 pro-like',
      },
    },
    keepalive: 'POST /api/v1/session-create with account Cookie',
    doc: 'docs/LONGCAT_PROTOCOL.md',
  });
});

// ─── system ─────────────────────────────────────────────────

router.get('/api/config', (_req, res) => {
  const c = config.get();
  res.json({
    ok: true,
    api_keys: c.api_keys,
    admin_password: c.admin_password,
    default_mode: c.default_mode,
    keepalive_interval_seconds: c.keepalive_interval_seconds,
    temp_mail: {
      ...config.getTempMail(),
      configured: isTempMailConfigured(config.getTempMail()),
    },
    proxy_pool: {
      ...config.getProxyPool(),
      status: proxyStatus(),
    },
  });
});

router.post('/api/config', (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.api_keys != null) patch.api_keys = String(body.api_keys);
  if (body.admin_password != null) patch.admin_password = String(body.admin_password);
  if (body.default_mode != null) patch.default_mode = body.default_mode;
  if (body.keepalive_interval_seconds != null) {
    patch.keepalive_interval_seconds = Number(body.keepalive_interval_seconds);
  }
  if (body.temp_mail && typeof body.temp_mail === 'object') {
    patch.temp_mail = { ...config.getTempMail(), ...body.temp_mail };
  }
  if (body.proxy_pool && typeof body.proxy_pool === 'object') {
    patch.proxy_pool = { ...config.getProxyPool(), ...body.proxy_pool };
  }
  config.update(patch);
  res.json({ ok: true, message: 'saved' });
});

router.get('/api/usage', (_req, res) => {
  res.json({ ok: true, usage: getUsage(60) });
});

router.get('/api/logs', (req, res) => {
  const limit = Math.min(500, Number(req.query.limit || 100));
  res.json({ ok: true, logs: listRequestLogs(limit) });
});

// ─── accounts ───────────────────────────────────────────────

router.get('/api/accounts', (_req, res) => {
  res.json({ ok: true, accounts: listAccounts({ includeSecrets: false }) });
});

router.post('/api/account/import-cookie', async (req, res) => {
  try {
    const body = req.body || {};
    const cookie = body.cookie || body.raw || '';
    if (!cookie) return res.status(400).json({ ok: false, error: 'cookie required' });
    const result = await importCookieAccount({
      cookie,
      name: body.name || '',
      email: body.email || '',
      password: body.password || '',
      mail_jwt: body.mail_jwt || '',
      note: body.note || '',
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/api/account/import-batch', async (req, res) => {
  try {
    const items = req.body?.cookies || req.body?.items || [];
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: 'cookies array required' });
    }
    const results = [];
    for (const item of items) {
      const cookie = typeof item === 'string' ? item : item.cookie;
      try {
        const r = await importCookieAccount({
          cookie,
          name: item.name || '',
          email: item.email || '',
        });
        results.push(r);
      } catch (e) {
        results.push({ ok: false, error: e.message });
      }
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/api/account/:id/test', async (req, res) => {
  const acc = getAccount(req.params.id);
  if (!acc) return res.status(404).json({ ok: false, error: 'not found' });
  const r = await probeAccount(acc);
  updateAccount(acc.id, {
    is_valid: r.ok,
    last_test_at: Date.now(),
    renew_error: r.ok ? '' : r.detail,
    error_count: r.ok ? 0 : (acc.error_count || 0) + 1,
  });
  res.json({ ok: r.ok, detail: r.detail, account: sanitizeAccount(getAccount(acc.id)) });
});

router.post('/api/account/:id/renew', async (req, res) => {
  const acc = getAccount(req.params.id);
  if (!acc) return res.status(404).json({ ok: false, error: 'not found' });
  const r = await renewOneAccount(acc);
  res.json(r);
});

router.post('/api/accounts/renew-all', async (_req, res) => {
  const r = await renewAll();
  res.json(r);
});

router.patch('/api/account/:id', (req, res) => {
  const acc = getAccount(req.params.id);
  if (!acc) return res.status(404).json({ ok: false, error: 'not found' });
  const body = req.body || {};
  const patch = {};
  for (const k of ['name', 'email', 'password', 'note', 'region', 'mail_jwt', 'cookie']) {
    if (body[k] != null) patch[k] = body[k];
  }
  if (body.enabled != null) patch.enabled = !!body.enabled;
  if (body.auto_renew != null) patch.auto_renew = !!body.auto_renew;
  if (body.cookie) {
    const map = parseCookieString(body.cookie);
    if (map.passport_token_key) patch.passport_token = map.passport_token_key;
    if (map._lxsdk_cuid) patch.lxsdk_cuid = map._lxsdk_cuid;
    if (map._lxsdk_s) patch.lxsdk_s = map._lxsdk_s;
  }
  updateAccount(acc.id, patch);
  res.json({ ok: true, account: sanitizeAccount(getAccount(acc.id)) });
});

router.delete('/api/account/:id', (req, res) => {
  deleteAccount(req.params.id);
  res.json({ ok: true });
});

router.post('/api/account/:id/bind-cookie', async (req, res) => {
  try {
    const cookie = req.body?.cookie || '';
    if (!cookie) return res.status(400).json({ ok: false, error: 'cookie required' });
    const r = await bindCookieToAccount(req.params.id, cookie);
    res.json(r);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── temp mail ──────────────────────────────────────────────

router.get('/api/temp-mail/config', async (_req, res) => {
  const tm = config.getTempMail();
  let domains = [];
  try {
    if (tm.api_base) domains = await listDomains(tm);
  } catch (e) {
    /* ignore */
  }
  res.json({
    ok: true,
    temp_mail: { ...tm, configured: isTempMailConfigured(tm) },
    domains,
  });
});

router.post('/api/temp-mail/config', (req, res) => {
  const body = req.body?.temp_mail || req.body || {};
  const prev = config.getTempMail();
  const next = { ...prev, ...body };
  // keep secrets if masked
  if (typeof next.admin_password === 'string' && next.admin_password.includes('***')) {
    next.admin_password = prev.admin_password;
  }
  config.update({ temp_mail: next });
  res.json({ ok: true, temp_mail: config.getTempMail() });
});

router.post('/api/temp-mail/test', async (req, res) => {
  const body = req.body?.temp_mail || req.body || {};
  const prev = config.getTempMail();
  const cfg = {
    ...prev,
    ...body,
    admin_password:
      body.admin_password && !String(body.admin_password).includes('***')
        ? body.admin_password
        : prev.admin_password,
  };
  const result = await testConnection(cfg);
  res.json(result);
});

// ─── register ───────────────────────────────────────────────

router.post('/api/account/prepare-mailbox', async (_req, res) => {
  try {
    const r = await prepareRegisterMailbox();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/api/account/auto-register', async (_req, res) => {
  try {
    const r = await runOneRegisterAttempt();
    res.json(r);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/api/account/auto-register-batch', (req, res) => {
  const tm = config.getTempMail();
  const body = req.body || {};
  const job = startBatchRegisterJob({
    success_target: body.success_target ?? tm.success_target ?? 3,
    max_attempts: body.max_attempts ?? body.batch_count ?? tm.batch_count ?? 5,
    concurrent: body.concurrent ?? tm.concurrent ?? 1,
  });
  res.json({ ok: true, job_id: job.id, job });
});

router.get('/api/account/auto-register-batch/:id', (req, res) => {
  const job = getRegisterJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'job not found' });
  res.json({ ok: true, job });
});

// ─── proxy pool ─────────────────────────────────────────────

router.get('/api/proxy/status', (_req, res) => {
  res.json({ ok: true, ...proxyStatus() });
});

router.post('/api/proxy/config', (req, res) => {
  const body = req.body?.proxy_pool || req.body || {};
  const prev = config.getProxyPool();
  const next = { ...prev, ...body };
  if (typeof next.sub_url === 'string' && next.sub_url.includes('***')) {
    next.sub_url = prev.sub_url;
  }
  configureProxyPool(next);
  res.json({ ok: true, proxy_pool: config.getProxyPool(), status: proxyStatus() });
});

router.post('/api/proxy/start', async (_req, res) => {
  try {
    const st = await startProxy({ pickRandom: true });
    res.json({ ok: true, ...st });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/api/proxy/stop', async (_req, res) => {
  const st = await stopProxy();
  res.json({ ok: true, ...st });
});

router.post('/api/proxy/rotate', async (_req, res) => {
  try {
    const st = await rotateProxy();
    res.json({ ok: true, ...st });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/api/proxy/test', async (_req, res) => {
  const r = await testProxyConnectivity();
  res.json(r);
});

router.post('/api/proxy/refresh', async (_req, res) => {
  try {
    const nodes = await fetchNodes();
    res.json({ ok: true, node_count: nodes.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;
