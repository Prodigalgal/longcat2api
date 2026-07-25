/**
 * Smoke-test Camoufox / Patchright launch + open mykeeta passport.
 * Does NOT register. Safe to re-run.
 *
 *   node scripts/local-browser-smoke.mjs
 *   $env:LONGCAT2API_BROWSER_ENGINE="camoufox"
 *   $env:LONGCAT2API_REGISTER_HEADLESS="0"
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { launchBrowser, browserStatus, defaultContextOptions } from '../src/services/browser.js';
import { buildLoginPageUrl } from '../src/services/mykeetaClient.js';

process.env.LONGCAT2API_REGISTER_HEADLESS =
  process.env.LONGCAT2API_REGISTER_HEADLESS ?? '0';

mkdirSync('data/debug', { recursive: true });

const status = await browserStatus();
console.log('[smoke] status', JSON.stringify(status, null, 2));

const engineWanted = process.env.LONGCAT2API_BROWSER_ENGINE || 'camoufox';
console.log('[smoke] preferred engine=', engineWanted, 'headless=', process.env.LONGCAT2API_REGISTER_HEADLESS);

let launched;
try {
  launched = await launchBrowser({
    preferred: engineWanted,
    headless: process.env.LONGCAT2API_REGISTER_HEADLESS !== '0',
  });
} catch (e) {
  console.error('[smoke] LAUNCH FAIL', e.message);
  writeFileSync(
    'data/debug/browser-smoke.json',
    JSON.stringify({ ok: false, error: e.message, status }, null, 2)
  );
  process.exit(1);
}

const { browser, engine, close } = launched;
console.log('[smoke] launched', engine);

const context = await browser.newContext(defaultContextOptions({ engine }));
const page = await context.newPage();
const url = buildLoginPageUrl();
console.log('[smoke] goto', url);

const result = {
  ok: false,
  engine,
  url,
  title: '',
  hasEmailLink: false,
  hasPhone: false,
  h5guard: false,
  error: '',
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(5000);
  result.title = await page.title();
  result.hasEmailLink = await page
    .locator('text=/Continue with email|邮箱|email/i')
    .first()
    .isVisible()
    .catch(() => false);
  result.hasPhone = await page
    .locator('text=/phone|mobile|手机/i')
    .first()
    .isVisible()
    .catch(() => false);
  result.h5guard = await page
    .evaluate(() => !!(window.H5guard || window.TokenStandardization))
    .catch(() => false);
  result.finalUrl = page.url();
  result.ok = true;

  const shot = `data/debug/browser-smoke-${engine}.png`;
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  result.screenshot = shot;
  console.log('[smoke] OK', result);
} catch (e) {
  result.error = e.message;
  console.error('[smoke] page fail', e.message);
} finally {
  await context.close().catch(() => {});
  await close();
}

writeFileSync('data/debug/browser-smoke.json', JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
