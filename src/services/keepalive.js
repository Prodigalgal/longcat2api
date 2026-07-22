import { config } from '../config.js';
import {
  listKeepaliveAccounts,
  updateAccount,
} from '../db/index.js';
import { probeAccount } from './longcatClient.js';
import { getProxyUrl } from './proxyPool.js';

let timer = null;
let running = false;

export async function renewOneAccount(acc) {
  const proxyUrl = getProxyUrl();
  const result = await probeAccount(acc, { proxyUrl: proxyUrl || undefined });
  const now = Date.now();
  if (result.ok) {
    updateAccount(acc.id, {
      is_valid: true,
      error_count: 0,
      last_test_at: now,
      last_renew_at: now,
      renew_error: '',
    });
    return { ok: true, id: acc.id, detail: result.detail };
  }
  const errCount = (acc.error_count || 0) + 1;
  updateAccount(acc.id, {
    is_valid: false,
    error_count: errCount,
    last_test_at: now,
    last_renew_at: now,
    renew_error: result.detail || 'probe failed',
    enabled: errCount >= 5 ? 0 : acc.enabled,
  });
  return { ok: false, id: acc.id, detail: result.detail };
}

export async function renewAll() {
  if (running) return { skipped: true, reason: 'already running' };
  running = true;
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
        results.push({ ok: false, id: acc.id, detail: e.message });
        console.error(`[KeepAlive] error id=${acc.id}:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { ok: true, results };
  } finally {
    running = false;
  }
}

export function startKeepaliveLoop() {
  if (timer) return;
  const intervalMs = config.getKeepaliveInterval() * 1000;
  console.log(
    `[KeepAlive] loop started, interval=${Math.floor(intervalMs / 1000)}s`
  );
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
