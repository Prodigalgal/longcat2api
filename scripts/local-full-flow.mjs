/**
 * Real online: register → DB → keepalive probe (≤3) → renewAll.
 *
 *   $env:CONFIG_PATH = (Resolve-Path data\config-local.json).Path
 *   $env:LONGCAT2API_REGISTER_HEADLESS = "0"
 *   $env:LONGCAT2API_BROWSER_ENGINE = "camoufox"
 *   $env:LONGCAT2API_PROXY_ENABLED = "0"
 *   node scripts/local-full-flow.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { config } from '../src/config.js';
import { initDb, accountPoolStats, getAccount } from '../src/db/index.js';
import { runOneRegisterAttempt } from '../src/services/register.js';
import { renewOneAccount, renewAll } from '../src/services/keepalive.js';

process.env.LONGCAT2API_REGISTER_HEADLESS = process.env.LONGCAT2API_REGISTER_HEADLESS || '0';
process.env.LONGCAT2API_BROWSER_ENGINE =
  process.env.LONGCAT2API_BROWSER_ENGINE || 'camoufox';
process.env.LONGCAT2API_PROXY_ENABLED = process.env.LONGCAT2API_PROXY_ENABLED || '0';

config.load();
initDb();
mkdirSync('data/debug', { recursive: true });

const logs = [];
const log = (m) => {
  logs.push(m);
  console.log('[flow]', m);
};

log('=== STEP 1: full-auto register ===');
let reg;
try {
  reg = await runOneRegisterAttempt({});
  log(
    'register result: ' +
      JSON.stringify({
        ok: reg.ok,
        email: reg.email,
        account_id: reg.account_id,
        has_cookie: reg.has_cookie,
        detail: reg.detail,
        message: reg.message,
        error: reg.error,
      })
  );
} catch (e) {
  log('register EXCEPTION: ' + e.message);
  writeFileSync(
    'data/debug/full-flow.json',
    JSON.stringify({ step: 'register', error: e.message, stack: e.stack, logs }, null, 2)
  );
  process.exit(1);
}

writeFileSync('data/debug/full-flow-register.json', JSON.stringify({ reg, logs }, null, 2));

if (!reg.account_id) {
  log('register failed without account');
  writeFileSync('data/debug/full-flow.json', JSON.stringify({ ok: false, reg, logs }, null, 2));
  process.exit(2);
}

const accountId = reg.account_id;
log('pool after register: ' + JSON.stringify(accountPoolStats()));

log('=== STEP 2: keepalive / probe (max 3) ===');
const acc = getAccount(accountId);
if (!acc) {
  log('account missing after register');
  process.exit(3);
}

const probeResults = [];
let probeOk = false;
for (let i = 1; i <= 3; i++) {
  log(`probe try ${i}/3 id=${acc.id}`);
  const r = await renewOneAccount(acc);
  probeResults.push(r);
  log(`  -> ${r.ok ? 'ok' : 'fail'} ${r.detail || ''}`);
  if (r.ok) {
    probeOk = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
  Object.assign(acc, getAccount(accountId) || {});
}

log('=== STEP 3: keepalive batch ===');
const all = await renewAll();
log(`renewAll: total=${all.total ?? all.results?.length} okCount=${all.okCount}`);

const finalAcc = getAccount(accountId);
const out = {
  ok: !!(probeOk || reg.ok) && !!finalAcc?.is_valid,
  register: {
    ok: reg.ok,
    email: reg.email,
    account_id: accountId,
    detail: reg.detail,
  },
  probe: probeResults,
  renewAll: { total: all.total, okCount: all.okCount, results: all.results },
  account: finalAcc
    ? {
        id: finalAcc.id,
        email: finalAcc.email,
        is_valid: !!finalAcc.is_valid,
        enabled: !!finalAcc.enabled,
        auto_renew: !!finalAcc.auto_renew,
        has_cookie: !!(finalAcc.cookie || finalAcc.passport_token),
        last_renew_at: finalAcc.last_renew_at,
        renew_error: finalAcc.renew_error,
      }
    : null,
  pool: accountPoolStats(),
  logs,
};
writeFileSync('data/debug/full-flow.json', JSON.stringify(out, null, 2));
console.log('\n=== FULL FLOW SUMMARY ===');
console.log(
  JSON.stringify(
    { ok: out.ok, register: out.register, account: out.account, pool: out.pool },
    null,
    2
  )
);
process.exit(out.ok ? 0 : 4);
