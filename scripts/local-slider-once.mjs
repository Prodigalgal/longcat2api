/**
 * Local: email submit → wait for Yoda → if slider solve traditional; refresh up to 8x.
 * Uses launchBrowser (Camoufox preferred).
 */
import { mkdirSync } from 'node:fs';
import { buildLoginPageUrl } from '../src/services/mykeetaClient.js';
import { detectSlider, solveSliderTraditional } from '../src/services/sliderCaptcha.js';
import { launchBrowser, defaultContextOptions } from '../src/services/browser.js';
import { config } from '../src/config.js';
import { createAddress } from '../src/services/tempMail.js';
import { getProxyUrl, startProxy, stopProxy } from '../src/services/proxyPool.js';

mkdirSync('data/debug', { recursive: true });
process.env.LONGCAT2API_BROWSER_ENGINE = process.env.LONGCAT2API_BROWSER_ENGINE || 'camoufox';
// default HEADED for local slider debug
if (process.env.LONGCAT2API_REGISTER_HEADLESS == null) {
  process.env.LONGCAT2API_REGISTER_HEADLESS = '0';
}

config.load();
let proxyUrl = null;
if (config.getProxyPool().enabled) {
  await startProxy({ pickRandom: true });
  proxyUrl = getProxyUrl();
}

const launched = await launchBrowser({
  headless: process.env.LONGCAT2API_REGISTER_HEADLESS !== '0',
  proxyUrl,
});
const { browser, engine, close } = launched;
console.log('engine=', engine, 'headless=', launched.headless);
const context = await browser.newContext(defaultContextOptions({ engine }));
const page = await context.newPage();
const apis = [];
page.on('response', async (r) => {
  if (/passport\.mykeeta\.com\/api\//.test(r.url()) || /mykeeta\.com\/api\//.test(r.url())) {
    let b = '';
    try {
      b = (await r.text()).slice(0, 150);
    } catch {
      /* ignore */
    }
    apis.push({ s: r.status(), u: r.url().slice(0, 100), b });
    console.log('API', r.status(), r.url().slice(0, 90), b.slice(0, 80));
  }
});

console.log('goto login');
await page.goto(buildLoginPageUrl(), { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(8000);
console.log('title', await page.title());

// switch to email
const emailBtn = page.locator('text=/Continue with email/i').first();
if (await emailBtn.isVisible().catch(() => false)) {
  await emailBtn.click();
  await page.waitForTimeout(2000);
}

const email = process.env.TEST_EMAIL || (await createAddress(config.getTempMail())).address;
const input = page.locator('input[placeholder*="Email"], input.oversea-input-container, input[type="email"]').first();
await input.waitFor({ timeout: 15000 });
await input.fill(email);
const submit = page.locator('div.submit-btn').first();
if (await submit.isVisible().catch(() => false)) {
  await submit.click();
} else {
  await page.getByText(/^Continue$/i).first().click();
}
console.log('submitted email', email);

const maxRounds = Math.max(1, Math.min(5, Number(process.env.LONGCAT2API_SLIDER_TEST_ROUNDS || 4)));
for (let i = 0; i < maxRounds; i++) {
  await page.waitForTimeout(2500);
  const det = await detectSlider(page);
  console.log('round', i, 'slider', det);
  if (det) {
    const r = await solveSliderTraditional(page, console.log);
    console.log('solve', r);
    if (r?.ok) break;
  }
  // refresh captcha if present
  const refresh = page
    .locator(
      '.global-puzzle-slider-operate-refresh, .sudoku-operate-refresh, .yoda-global-inference-wrapper img[src*="refresh"], img[alt="refresh"]'
    )
    .first();
  if (await refresh.isVisible().catch(() => false)) await refresh.click().catch(() => {});
}

await page.screenshot({ path: `data/debug/slider-once-${engine}.png`, fullPage: true }).catch(() => {});
console.log('apis', apis.slice(-10));
await context.close();
await close();
await stopProxy().catch(() => {});
