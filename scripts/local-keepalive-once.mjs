/**
 * One-shot keepalive / probe for all enabled accounts (local).
 * Max 3 probes per account per run (LONGCAT2API_MAX_PROBE_PER_ACCOUNT).
 *
 *   node scripts/local-keepalive-once.mjs
 */
import { config } from '../src/config.js';
import { initDb, listKeepaliveAccounts, getAccount } from '../src/db/index.js';
import { renewOneAccount, renewAll } from '../src/services/keepalive.js';
import { writeFileSync, mkdirSync } from 'node:fs';

config.load();
initDb();
mkdirSync('data/debug', { recursive: true });

const maxPer = Number(process.env.LONGCAT2API_MAX_PROBE_PER_ACCOUNT || 3);
const accounts = listKeepaliveAccounts();
console.log(`[keepalive-once] accounts=${accounts.length} max_probe_per=${maxPer}`);

if (!accounts.length) {
  console.log('[keepalive-once] no accounts — import a cookie first or register');
  writeFileSync(
    'data/debug/keepalive-once.json',
    JSON.stringify({ ok: true, accounts: 0, results: [] }, null, 2)
  );
  process.exit(0);
}

const results = [];
for (const acc of accounts) {
  let last = null;
  for (let i = 1; i <= maxPer; i++) {
    console.log(`[keepalive-once] probe ${acc.id} try ${i}/${maxPer} email=${acc.email || ''}`);
    last = await renewOneAccount(acc);
    console.log(`  → ${last.ok ? 'ok' : 'fail'} ${last.detail || ''}`);
    if (last.ok) break;
    // refresh row for error_count
    const fresh = getAccount(acc.id);
    if (fresh) Object.assign(acc, fresh);
    await new Promise((r) => setTimeout(r, 1500));
  }
  results.push({ id: acc.id, email: acc.email, ...last });
}

const ok = results.filter((r) => r.ok).length;
const out = { ok: ok === results.length, total: results.length, okCount: ok, results };
writeFileSync('data/debug/keepalive-once.json', JSON.stringify(out, null, 2));
console.log('\n=== SUMMARY ===', JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 2);
