/**
 * Local HEADED register test — Camoufox preferred, Patchright fallback.
 *
 * PowerShell:
 *   $env:LONGCAT2API_REGISTER_HEADLESS="0"
 *   $env:LONGCAT2API_BROWSER_ENGINE="camoufox"   # or patchright
 *   node scripts/local-headed-register.mjs
 *
 * Cap: only 1 attempt here; batch max_attempts should stay ≤3 for local.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { registerOneAccount } from '../src/services/mykeetaBrowserRegister.js';

process.env.LONGCAT2API_REGISTER_HEADLESS = process.env.LONGCAT2API_REGISTER_HEADLESS || '0';
process.env.LONGCAT2API_BROWSER_ENGINE =
  process.env.LONGCAT2API_BROWSER_ENGINE || process.env.REGISTER_BROWSER || 'camoufox';

config.load();
mkdirSync('data/debug', { recursive: true });

console.log('[local-headed] headless=', process.env.LONGCAT2API_REGISTER_HEADLESS);
console.log('[local-headed] engine=', process.env.LONGCAT2API_BROWSER_ENGINE);
console.log('[local-headed] temp_mail=', config.getTempMail().api_base);

const logs = [];
try {
  const r = await registerOneAccount({
    onLog: (m) => {
      logs.push(m);
      console.log('[log]', m);
    },
    timeoutMs: Number(process.env.LONGCAT2API_REGISTER_TIMEOUT_MS || 480000),
  });
  writeFileSync('data/debug/headed-result.json', JSON.stringify({ r, logs }, null, 2));
  console.log('\n=== RESULT ===\n', JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 2);
} catch (e) {
  writeFileSync(
    'data/debug/headed-result.json',
    JSON.stringify({ error: e.message, stack: e.stack, logs }, null, 2)
  );
  console.error('\n=== FAIL ===', e.message);
  process.exit(1);
}
