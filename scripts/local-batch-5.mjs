/**
 * Real online batch: register until N probe-ok accounts (default 5).
 * Sequential only (headed captcha is not parallel-safe).
 *
 *   $env:CONFIG_PATH = (Resolve-Path data\config-local.json).Path
 *   $env:LONGCAT2API_REGISTER_HEADLESS = "0"
 *   $env:LONGCAT2API_BROWSER_ENGINE = "camoufox"
 *   $env:LONGCAT2API_PROXY_ENABLED = "0"
 *   node scripts/local-batch-5.mjs
 */
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { config } from '../src/config.js';
import {
  initDb,
  accountPoolStats,
  listAccounts,
  getAccount,
} from '../src/db/index.js';
import { runOneRegisterAttempt } from '../src/services/register.js';
import { renewOneAccount } from '../src/services/keepalive.js';

process.env.LONGCAT2API_REGISTER_HEADLESS = process.env.LONGCAT2API_REGISTER_HEADLESS || '0';
process.env.LONGCAT2API_BROWSER_ENGINE =
  process.env.LONGCAT2API_BROWSER_ENGINE || 'camoufox';
process.env.LONGCAT2API_PROXY_ENABLED = process.env.LONGCAT2API_PROXY_ENABLED || '0';
process.env.LONGCAT2API_REGISTER_TIMEOUT_MS =
  process.env.LONGCAT2API_REGISTER_TIMEOUT_MS || '480000';

const TARGET = Math.max(1, Number(process.env.LONGCAT2API_BATCH_TARGET || 5));
const MAX_ATTEMPTS = Math.max(
  TARGET,
  Number(process.env.LONGCAT2API_BATCH_MAX_ATTEMPTS || TARGET + 10)
);
const COOLDOWN_MS = Math.max(3000, Number(process.env.LONGCAT2API_BATCH_COOLDOWN_MS || 8000));

config.load();
initDb();
mkdirSync('data/debug', { recursive: true });

const startedAt = Date.now();
const logPath = 'data/debug/batch-5.log';
const results = [];
const logs = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logs.push(line);
  console.log(line);
  try {
    appendFileSync(logPath, line + '\n');
  } catch {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const before = accountPoolStats();
log(
  `=== BATCH START target=${TARGET} max_attempts=${MAX_ATTEMPTS} pool_before=${JSON.stringify(before)} ===`
);
log(
  `engine=${process.env.LONGCAT2API_BROWSER_ENGINE} headless=${process.env.LONGCAT2API_REGISTER_HEADLESS} proxy=${process.env.LONGCAT2API_PROXY_ENABLED}`
);

let success = 0;
let fail = 0;
const successIds = [];

for (let attempt = 1; attempt <= MAX_ATTEMPTS && success < TARGET; attempt++) {
  log(`\n======== ATTEMPT ${attempt}/${MAX_ATTEMPTS} (success ${success}/${TARGET}) ========`);
  let r;
  try {
    r = await runOneRegisterAttempt({});
  } catch (e) {
    r = { ok: false, error: e.message, message: e.message };
  }

  const summary = {
    attempt,
    ok: !!r.ok,
    email: r.email || '',
    account_id: r.account_id || '',
    detail: r.detail || r.error || r.message || '',
  };
  results.push(summary);
  log(
    `register => ok=${summary.ok} email=${summary.email} id=${summary.account_id} detail=${String(summary.detail).slice(0, 160)}`
  );

  if (r.ok && r.account_id) {
    // extra keepalive probe (max 2)
    let probeOk = false;
    for (let p = 1; p <= 2; p++) {
      const acc = getAccount(r.account_id);
      if (!acc) break;
      const kr = await renewOneAccount(acc);
      log(`  keepalive probe ${p}/2 => ${kr.ok ? 'ok' : 'fail'} ${kr.detail || ''}`);
      if (kr.ok) {
        probeOk = true;
        break;
      }
      await sleep(1500);
    }
    if (probeOk || r.ok) {
      success++;
      successIds.push(r.account_id);
      log(`SUCCESS #${success}/${TARGET} id=${r.account_id} email=${r.email}`);
    } else {
      fail++;
      log(`FAIL probe after register id=${r.account_id}`);
    }
  } else {
    fail++;
    log(`FAIL attempt ${attempt}`);
  }

  writeFileSync(
    'data/debug/batch-5-progress.json',
    JSON.stringify(
      {
        success,
        fail,
        attempt,
        target: TARGET,
        successIds,
        results,
        pool: accountPoolStats(),
        elapsed_ms: Date.now() - startedAt,
      },
      null,
      2
    )
  );

  if (success >= TARGET) break;
  log(`cooldown ${COOLDOWN_MS}ms before next attempt…`);
  await sleep(COOLDOWN_MS);
}

const pool = accountPoolStats();
const accounts = listAccounts({ includeSecrets: false }).filter((a) => a.is_valid);
const out = {
  ok: success >= TARGET,
  target: TARGET,
  success,
  fail,
  attempts: results.length,
  successIds,
  results,
  pool,
  valid_accounts: accounts.map((a) => ({
    id: a.id,
    email: a.email,
    last_renew_at: a.last_renew_at,
  })),
  elapsed_ms: Date.now() - startedAt,
  logs_tail: logs.slice(-80),
};

writeFileSync('data/debug/batch-5-result.json', JSON.stringify(out, null, 2));
log('\n=== BATCH DONE ===');
log(JSON.stringify({ ok: out.ok, success, fail, attempts: out.attempts, pool, successIds }, null, 2));
process.exit(out.ok ? 0 : 2);
