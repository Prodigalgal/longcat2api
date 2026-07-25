import { config } from '../config.js';
import {
  listKeepaliveAccounts,
  updateAccount,
  accountPoolStats,
} from '../db/index.js';
import { probeAccount } from './longcatClient.js';
import { getProxyUrl } from './proxyPool.js';
import { reauthorizeAccount } from './accountReauthorization.js';

let timer = null;
let running = false;
let lastRun = null;
let lastResults = [];
let nextAt = null;
const recoveryFlights = new Map();

export function shouldReauthorize(acc, detail = '') {
  if (!acc?.email || (!acc.password && !acc.mail_jwt)) return false;
  if (!acc.cookie && !acc.passport_token) return true;
  return /auth|unauthor|forbidden|expired|invalid.*(?:cookie|token|session)|cookie|token|not\s*logged|log\s*in|login|登录|未登录|HTTP\s*(?:401|403)/i.test(
    String(detail || '')
  );
}

async function recoverAccount(acc) {
  if (recoveryFlights.has(acc.id)) return recoveryFlights.get(acc.id);
  const flight = (async () => {
    const recovered = await reauthorizeAccount(acc, {
      onLog: (message) => console.log(`[KeepAlive][Reauthorize] id=${acc.id} ${message}`),
    });
    if (!recovered?.ok || !recovered.passport_token) {
      throw new Error(recovered?.error || 'reauthorization returned no token');
    }
    return updateAccount(acc.id, {
      cookie: recovered.header || recovered.cookie || '',
      passport_token: recovered.passport_token,
      lxsdk_cuid: recovered.lxsdk_cuid || '',
      lxsdk_s: recovered.lxsdk_s || '',
      enabled: true,
      is_valid: false,
      renew_error: '',
    });
  })().finally(() => recoveryFlights.delete(acc.id));
  recoveryFlights.set(acc.id, flight);
  return flight;
}

export async function renewOneAccount(acc) {
  // Prefer direct probe for keepalive unless proxy pool is healthy
  let proxyUrl;
  try {
    proxyUrl = getProxyUrl() || undefined;
  } catch {
    proxyUrl = undefined;
  }
  let current = acc;
  let result = await probeAccount(current, { proxyUrl });
  let reauthorized = false;
  if (!result.ok && shouldReauthorize(current, result.detail)) {
    try {
      current = await recoverAccount(current);
      result = await probeAccount(current, { proxyUrl });
      reauthorized = result.ok;
      if (!result.ok) {
        result.detail = `reauthorized but probe failed: ${result.detail || 'unknown'}`;
      }
    } catch (error) {
      result = {
        ok: false,
        detail: `reauthorization failed: ${error.message}`,
      };
    }
  }
  const now = Date.now();
  if (result.ok) {
    updateAccount(acc.id, {
      is_valid: true,
      error_count: 0,
      last_test_at: now,
      last_renew_at: now,
      renew_error: '',
    });
    return {
      ok: true,
      id: acc.id,
      email: acc.email,
      detail: result.detail,
      reauthorized,
    };
  }
  const errCount = (acc.error_count || 0) + 1;
  // Max 3 probe failures before soft-disable (user preference)
  const maxFail = Number(process.env.LONGCAT2API_MAX_PROBE_PER_ACCOUNT || 3);
  updateAccount(acc.id, {
    is_valid: false,
    error_count: errCount,
    last_test_at: now,
    last_renew_at: now,
    renew_error: result.detail || 'probe failed',
    enabled: errCount >= maxFail ? 0 : acc.enabled,
  });
  return { ok: false, id: acc.id, email: acc.email, detail: result.detail };
}

export async function renewAll() {
  if (running) return { skipped: true, reason: 'already running', ...keepaliveStatus() };
  running = true;
  lastRun = Date.now();
  try {
    const accounts = listKeepaliveAccounts();
    console.log(`[KeepAlive] checking ${accounts.length} account(s)...`);
    const results = [];
    for (const acc of accounts) {
      try {
        const r = await renewOneAccount(acc);
        results.push(r);
        console.log(
          `[KeepAlive] ${r.ok ? 'ok' : 'fail'} id=${acc.id} ${r.detail || ''}`
        );
      } catch (e) {
        results.push({ ok: false, id: acc.id, email: acc.email, detail: e.message });
        console.error(`[KeepAlive] error id=${acc.id}:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    lastResults = results;
    const ok = results.filter((r) => r.ok).length;
    return { ok: true, total: results.length, okCount: ok, results };
  } finally {
    running = false;
    nextAt = Date.now() + config.getKeepaliveInterval() * 1000;
  }
}

export function keepaliveStatus() {
  const pool = accountPoolStats();
  const due = listKeepaliveAccounts().filter((a) => {
    const last = a.last_renew_at || 0;
    return Date.now() - last > config.getKeepaliveInterval() * 1000;
  }).length;
  const failed = lastResults.filter((r) => !r.ok).length;
  return {
    running,
    interval_seconds: config.getKeepaliveInterval(),
    last_run: lastRun,
    nextAt,
    due,
    failed,
    leased: 0,
    concurrency: 1,
    pool,
    last_results: lastResults.slice(-20),
  };
}

export function startKeepaliveLoop() {
  if (timer) return;
  const intervalMs = config.getKeepaliveInterval() * 1000;
  console.log(
    `[KeepAlive] loop started, interval=${Math.floor(intervalMs / 1000)}s`
  );
  nextAt = Date.now() + 60_000;
  // first run after 60s
  setTimeout(() => {
    renewAll().catch((e) => console.error('[KeepAlive]', e));
  }, 60_000);
  timer = setInterval(() => {
    renewAll().catch((e) => console.error('[KeepAlive]', e));
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopKeepaliveLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
