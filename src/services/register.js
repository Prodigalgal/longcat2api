/**
 * LongCat 注册机（仅海外 mykeeta 邮箱）
 *
 * 全自动：Playwright 打开 passport.mykeeta.com（加载 H5guard）
 *   → 邮箱 OTP（Cloudflare Temp Mail）→ longcat Cookie → 入库探测
 *
 * 半自动兜底：浏览器不可用时仅创建邮箱 + draft
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import {
  insertAccount,
  updateAccount,
  createRegisterJob,
  appendRegisterLog,
  patchRegisterJob,
  getRegisterJob,
  getAccount,
} from '../db/index.js';
import { createAddress, isTempMailConfigured } from './tempMail.js';
import {
  startProxy,
  getProxyUrl,
  rotateProxy,
  proxyStatus,
} from './proxyPool.js';
import { probeAccount } from './longcatClient.js';
import { buildLoginPageUrl, summarizeFlow } from './mykeetaClient.js';
import { registerOneAccount } from './mykeetaBrowserRegister.js';

export function parseCookieString(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  const body = s.replace(/^cookie:\s*/i, '');
  const map = {};
  for (const part of body.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) map[k] = v;
  }
  return map;
}

export function normalizeAccountFromCookie({
  cookie,
  name = '',
  email = '',
  password = '',
  mail_jwt = '',
  note = '',
  region = 'oversea',
}) {
  const map = parseCookieString(cookie);
  const passport =
    map.passport_token_key || map.passport_token || map['passport_token_key'] || '';
  const fullCookie =
    cookie.includes('=') && cookie.includes(';')
      ? cookie.replace(/^cookie:\s*/i, '').trim()
      : [
          map._lxsdk_cuid && `_lxsdk_cuid=${map._lxsdk_cuid}`,
          passport && `passport_token_key=${passport}`,
          map._lxsdk_s && `_lxsdk_s=${map._lxsdk_s}`,
        ]
          .filter(Boolean)
          .join('; ');

  if (!passport && !fullCookie) {
    throw new Error('Cookie 中未找到 passport_token_key');
  }

  return {
    id: randomUUID().replace(/-/g, '').slice(0, 16),
    name: name || email || `acc-${Date.now().toString(36)}`,
    email,
    password,
    cookie: fullCookie || `passport_token_key=${passport}`,
    passport_token: passport,
    lxsdk_cuid: map._lxsdk_cuid || '',
    lxsdk_s: map._lxsdk_s || '',
    mail_jwt,
    region,
    note,
    enabled: true,
    auto_renew: true,
    is_valid: false,
  };
}

export async function importCookieAccount(input, { probe = true } = {}) {
  const acc = normalizeAccountFromCookie(input);
  insertAccount(acc);
  if (probe) {
    const r = await probeAccount(acc);
    updateAccount(acc.id, {
      is_valid: r.ok,
      last_test_at: Date.now(),
      renew_error: r.ok ? '' : r.detail,
    });
    return { ok: r.ok, account_id: acc.id, detail: r.detail, email: acc.email };
  }
  return { ok: true, account_id: acc.id, detail: 'saved without probe' };
}

export async function prepareRegisterMailbox() {
  const tm = config.getTempMail();
  if (!isTempMailConfigured(tm)) {
    throw new Error('请先配置临时邮箱');
  }
  const pp = config.getProxyPool();
  let proxy = null;
  let proxy_error = '';
  if (pp.enabled) {
    try {
      if (proxyStatus().status !== 'running') {
        await startProxy({ pickRandom: true });
      } else {
        await rotateProxy();
      }
      proxy = getProxyUrl();
    } catch (e) {
      proxy_error = e.message || String(e);
      console.warn('[Register] proxy start failed:', proxy_error);
    }
  }
  const addr = await createAddress(tm);
  return {
    email: addr.address,
    mail_jwt: addr.jwt,
    proxy_url: proxy,
    proxy_error: proxy_error || undefined,
    region: 'oversea',
    passport: 'https://passport.mykeeta.com',
    mykeeta_login_url: buildLoginPageUrl(),
    flow: summarizeFlow(),
    auto_register_ready: true,
    tip: '全自动请用 /api/account/auto-register；需 Playwright chromium + 建议海外代理。',
  };
}

function randomPassword() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#';
  let s = '';
  for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

/**
 * Full auto register one account (Playwright + temp mail).
 * Falls back to draft mailbox if browser fails and soft_fail=true.
 */
export async function runOneRegisterAttempt({ jobId, soft_fail = false } = {}) {
  const log = (msg) => {
    console.log(`[Register] ${msg}`);
    if (jobId) appendRegisterLog(jobId, msg);
  };

  try {
    log('full-auto mykeeta browser register starting...');
    const result = await registerOneAccount({
      onLog: log,
      // LongCat / mykeeta often slow — default 7 minutes
      timeoutMs: Number(process.env.LONGCAT2API_REGISTER_TIMEOUT_MS || 420000),
    });

    const acc = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      name: result.email,
      email: result.email,
      password: result.password,
      cookie: result.cookie,
      passport_token: result.passport_token,
      lxsdk_cuid: result.lxsdk_cuid || '',
      lxsdk_s: result.lxsdk_s || '',
      mail_jwt: result.mail_jwt,
      region: 'oversea',
      note: 'auto_mykeeta_browser',
      enabled: true,
      auto_renew: true,
      is_valid: false,
    };
    insertAccount(acc);

    const probe = await probeAccount(acc);
    updateAccount(acc.id, {
      is_valid: probe.ok,
      last_test_at: Date.now(),
      renew_error: probe.ok ? '' : probe.detail,
    });
    log(`probe: ${probe.ok ? 'ok' : 'fail'} ${probe.detail || ''}`);

    return {
      ok: probe.ok,
      account_id: acc.id,
      email: result.email,
      password: result.password,
      has_cookie: true,
      detail: probe.detail || result.detail,
      message: probe.ok
        ? '注册成功且 session 探测通过'
        : '注册拿到 Cookie 但探测失败（可能风控/地区）',
    };
  } catch (e) {
    log(`full-auto failed: ${e.message}`);
    if (!soft_fail) {
      return {
        ok: false,
        error: e.message,
        message: `全自动注册失败: ${e.message}`,
      };
    }

    // soft fallback: draft mailbox only
    log('soft_fail → create draft mailbox only');
    const prepared = await prepareRegisterMailbox();
    const draft = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      name: prepared.email,
      email: prepared.email,
      password: randomPassword(),
      cookie: '',
      passport_token: '',
      mail_jwt: prepared.mail_jwt,
      region: 'oversea',
      note: 'awaiting_mykeeta_cookie_bind',
      enabled: false,
      auto_renew: true,
      is_valid: false,
    };
    insertAccount(draft);
    return {
      ok: false,
      pending_cookie: true,
      account_id: draft.id,
      email: prepared.email,
      password: draft.password,
      mail_jwt: prepared.mail_jwt,
      mykeeta_login_url: prepared.mykeeta_login_url,
      proxy_url: prepared.proxy_url,
      error: e.message,
      message: `全自动失败，已创建 draft 邮箱供手动绑定: ${e.message}`,
    };
  }
}

export async function bindCookieToAccount(accountId, cookie) {
  const prev = getAccount(accountId);
  if (!prev) throw new Error('account not found');
  const parsed = normalizeAccountFromCookie({
    cookie,
    email: prev.email,
    password: prev.password,
    mail_jwt: prev.mail_jwt,
    name: prev.name,
  });
  updateAccount(accountId, {
    cookie: parsed.cookie,
    passport_token: parsed.passport_token,
    lxsdk_cuid: parsed.lxsdk_cuid,
    lxsdk_s: parsed.lxsdk_s,
    enabled: true,
    note: 'cookie_bound',
  });
  const acc = getAccount(accountId);
  const r = await probeAccount(acc);
  updateAccount(accountId, {
    is_valid: r.ok,
    last_test_at: Date.now(),
    renew_error: r.ok ? '' : r.detail,
  });
  return { ok: r.ok, detail: r.detail, account_id: accountId };
}

/**
 * Batch full-auto register. success = probe-ok accounts with cookie.
 */
export function startBatchRegisterJob({
  success_target = 3,
  max_attempts = 5,
  concurrent = 1,
  soft_fail = false,
} = {}) {
  const id = randomUUID();
  createRegisterJob({
    id,
    success_target,
    max_attempts,
    concurrent,
  });

  (async () => {
    let success = 0;
    let fail = 0;
    let attempt = 0;
    const limit = Math.max(1, max_attempts);
    const target = Math.max(0, success_target);
    const conc = Math.max(1, Math.min(3, Number(concurrent) || 1));

    appendRegisterLog(id, `batch full-auto start target=${target} max=${limit} concurrent=${conc}`);

    while (attempt < limit && (target === 0 || success < target)) {
      const batch = Math.min(conc, limit - attempt, target === 0 ? conc : target - success);
      const tasks = [];
      for (let i = 0; i < batch; i++) {
        attempt++;
        tasks.push(
          (async () => {
            try {
              const r = await runOneRegisterAttempt({ jobId: id, soft_fail });
              if (r.ok && r.has_cookie !== false && !r.pending_cookie) {
                success++;
                appendRegisterLog(id, `OK #${success} email=${r.email} id=${r.account_id}`);
              } else {
                fail++;
                appendRegisterLog(
                  id,
                  `FAIL email=${r.email || '-'} err=${r.error || r.message || 'pending'}`
                );
              }
            } catch (e) {
              fail++;
              appendRegisterLog(id, `FAIL exception: ${e.message}`);
            }
          })()
        );
      }
      patchRegisterJob(id, {
        attempt_count: attempt,
        success_count: success,
        fail_count: fail,
      });
      await Promise.all(tasks);
      patchRegisterJob(id, {
        attempt_count: attempt,
        success_count: success,
        fail_count: fail,
      });
      await new Promise((r) => setTimeout(r, 2000));
    }

    patchRegisterJob(id, {
      status: 'done',
      finished_at: Date.now(),
      success_count: success,
      fail_count: fail,
      attempt_count: attempt,
    });
    appendRegisterLog(id, `batch done success=${success} fail=${fail}`);
  })().catch((e) => {
    patchRegisterJob(id, { status: 'error', finished_at: Date.now() });
    appendRegisterLog(id, `batch error: ${e.message}`);
  });

  return getRegisterJob(id);
}
