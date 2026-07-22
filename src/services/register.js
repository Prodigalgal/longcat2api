/**
 * LongCat 注册机（仅海外）
 *
 * 海外邮箱：passport.mykeeta.com（不是国内 passport.meituan.com）
 * 完整协议见 docs/LONGCAT_PROTOCOL.md + services/mykeetaClient.js
 *
 * 本模块提供：
 * 1) 临时邮箱 + 海外代理（注册前置，出口必须非 CN）
 * 2) Cookie / passport_token 导入入库（登录态对话主路径）
 * 3) 批量导入 Cookie
 * 4) 半自动：创建邮箱 → 返回 mykeeta 登录 URL → 人工/后续自动 OTP 后绑 Cookie
 * 5) 连通性探测后标记 is_valid（session-create 保活）
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

export function parseCookieString(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  // strip "Cookie: " prefix
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
  if (pp.enabled) {
    try {
      if (proxyStatus().status !== 'running') {
        await startProxy({ pickRandom: true });
      } else {
        await rotateProxy();
      }
      proxy = getProxyUrl();
    } catch (e) {
      throw new Error(`代理池启动失败: ${e.message}`);
    }
  }
  const addr = await createAddress(tm);
  const mykeetaLoginUrl = buildLoginPageUrl();
  return {
    email: addr.address,
    mail_jwt: addr.jwt,
    proxy_url: proxy,
    region: 'oversea',
    passport: 'https://passport.mykeeta.com',
    mykeeta_login_url: mykeetaLoginUrl,
    flow: summarizeFlow(),
    tip:
      '仅海外：用该邮箱打开 mykeeta_login_url 完成邮箱 OTP 注册/登录（勿走 passport.meituan.com）。' +
      '成功后把 longcat.chat 的 Cookie（含 passport_token_key）导入。注册出口请走海外代理。',
  };
}

/**
 * Single auto-register attempt:
 * - create mailbox + proxy
 * - cannot complete Meituan passport fully headless; records staged job log
 * - returns mailbox for manual cookie bind OR future extension hooks
 */
export async function runOneRegisterAttempt({ jobId } = {}) {
  const log = (msg) => {
    console.log(`[Register] ${msg}`);
    if (jobId) appendRegisterLog(jobId, msg);
  };

  log('创建临时邮箱（海外 mykeeta 邮箱注册前置）...');
  const prepared = await prepareRegisterMailbox();
  log(`邮箱: ${prepared.email}`);
  if (prepared.proxy_url) log(`代理: ${prepared.proxy_url}`);
  log(`Passport: ${prepared.passport}`);
  log(`Login URL: ${prepared.mykeeta_login_url}`);
  log(prepared.tip);

  // Draft account for cookie bind after mykeeta email OTP (auto or manual).
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
  log(`已创建待绑定账号 draft_id=${draft.id} password=${draft.password}`);

  return {
    ok: false,
    pending_cookie: true,
    account_id: draft.id,
    email: prepared.email,
    password: draft.password,
    mail_jwt: prepared.mail_jwt,
    mykeeta_login_url: prepared.mykeeta_login_url,
    proxy_url: prepared.proxy_url,
    flow: prepared.flow,
    message:
      '请用海外 IP + 该邮箱在 passport.mykeeta.com 完成邮箱验证码注册/登录，' +
      '再把 longcat.chat Cookie 绑定到 account_id。协议细节见 docs/LONGCAT_PROTOCOL.md',
  };
}

function randomPassword() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#';
  let s = '';
  for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export async function bindCookieToAccount(accountId, cookie) {
  const { getAccount } = await import('../db/index.js');
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
 * Batch job: create N mailboxes / draft accounts asynchronously
 */
export function startBatchRegisterJob({ success_target = 3, max_attempts = 5, concurrent = 1 } = {}) {
  const id = randomUUID();
  createRegisterJob({
    id,
    success_target,
    max_attempts,
    concurrent,
  });

  // fire and forget
  (async () => {
    let success = 0;
    let fail = 0;
    let attempt = 0;
    const limit = Math.max(1, max_attempts);
    const target = Math.max(0, success_target);

    appendRegisterLog(id, `batch start target=${target} max=${limit}`);

    while (attempt < limit && (target === 0 || success < target)) {
      attempt++;
      patchRegisterJob(id, { attempt_count: attempt });
      try {
        const r = await runOneRegisterAttempt({ jobId: id });
        // pending_cookie counts as "prepared success" for mailbox pipeline
        if (r.pending_cookie || r.ok) {
          success++;
          patchRegisterJob(id, { success_count: success });
          appendRegisterLog(id, `prepared #${success} email=${r.email}`);
        } else {
          fail++;
          patchRegisterJob(id, { fail_count: fail });
        }
      } catch (e) {
        fail++;
        patchRegisterJob(id, { fail_count: fail });
        appendRegisterLog(id, `fail: ${e.message}`);
      }
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
