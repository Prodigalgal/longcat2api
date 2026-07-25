/**
 * Local one-shot register test (no K8s deploy loop).
 *
 * Usage (PowerShell):
 *   $env:LONGCAT2API_TEMP_MAIL_API_BASE="https://apimail.omnnu.xyz"
 *   $env:LONGCAT2API_TEMP_MAIL_ADMIN_PASSWORD="..."
 *   $env:LONGCAT2API_CAPTCHA_AI_ENABLED="false"   # optional
 *   $env:LONGCAT2API_PROXY_ENABLED="false"
 *   $env:LONGCAT2API_REGISTER_HEADLESS="0"         # 0=see browser
 *   node scripts/local-register-once.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { registerOneAccount } from '../src/services/mykeetaBrowserRegister.js';
import { config } from '../src/config.js';

// Force re-load env into config
config.load();

const headless = process.env.LONGCAT2API_REGISTER_HEADLESS !== '0';
console.log('[local] headless=', headless);
console.log('[local] temp_mail=', config.getTempMail().api_base);
console.log('[local] captcha_ai=', config.getCaptchaAi());

mkdirSync('data/debug', { recursive: true });

const logs = [];
const onLog = (m) => {
  logs.push(m);
  console.log('[log]', m);
};

try {
  const r = await registerOneAccount({
    onLog,
    timeoutMs: Number(process.env.LONGCAT2API_REGISTER_TIMEOUT_MS || 420000),
  });
  writeFileSync('data/debug/local-register-result.json', JSON.stringify({ r, logs }, null, 2));
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 2);
} catch (e) {
  writeFileSync(
    'data/debug/local-register-result.json',
    JSON.stringify({ error: e.message, stack: e.stack, logs }, null, 2)
  );
  console.error('\n=== FAIL ===', e.message);
  process.exit(1);
}
