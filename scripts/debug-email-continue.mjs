import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';

const url =
  'https://passport.mykeeta.com/pc/login?locale=en&region=HK&joinkey=1101498_851697727&token_id=5oTEq210UBLUcm4tcuuy6A&service=consumer&risk_cost_id=119801&theme=longcat&cityId=810001&backurl=https%3A%2F%2Flongcat.chat%2Fapi%2Fv1%2Fuser-loginV3%3Furl%3Dhttps%253A%252F%252Flongcat.chat%252F';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const apis = [];
page.on('request', (r) => {
  if (/passport\.mykeeta\.com\/api\//.test(r.url())) {
    apis.push({ m: r.method(), u: r.url(), post: (r.postData() || '').slice(0, 300) });
  }
});
page.on('response', async (r) => {
  if (!/passport\.mykeeta\.com\/api\//.test(r.url())) return;
  let b = '';
  try {
    b = (await r.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  apis.push({ resp: r.status(), u: r.url(), b });
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(6000);
await page.getByText(/continue with email/i).first().click();
await page.waitForTimeout(3000);

const cont = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const t = (el.innerText || '').trim();
    if (t === 'Continue' || t === '继续') {
      out.push({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 120),
        id: el.id,
        role: el.getAttribute('role'),
        disabled: el.getAttribute('disabled'),
        aria: el.getAttribute('aria-disabled'),
        childCount: el.children.length,
      });
    }
  }
  return out;
});
console.log('continue nodes', JSON.stringify(cont, null, 2));

const email = `testreg${Date.now()}@edu.omnnu.xyz`;
const input = page.locator('input[placeholder*="Email" i], input.oversea-input-container').first();
await input.click();
await input.fill('');
await input.pressSequentially(email, { delay: 25 });
await page.waitForTimeout(800);

// Try several continue click strategies
const strategies = [
  async () => page.getByText('Continue', { exact: true }).last().click({ force: true }),
  async () => page.locator('div').filter({ hasText: /^Continue$/ }).last().click({ force: true }),
  async () =>
    page.evaluate(() => {
      const nodes = [...document.querySelectorAll('div,span,button')];
      const el = nodes.find((n) => (n.innerText || '').trim() === 'Continue' && n.children.length === 0)
        || nodes.find((n) => (n.innerText || '').trim() === 'Continue');
      if (el) el.click();
    }),
];
for (let i = 0; i < strategies.length; i++) {
  console.log('strategy', i);
  try {
    await strategies[i]();
  } catch (e) {
    console.log('strategy fail', e.message);
  }
  await page.waitForTimeout(5000);
  if (apis.length) break;
}

console.log('apis', JSON.stringify(apis, null, 2));
console.log('body', (await page.locator('body').innerText()).slice(0, 1000));
mkdirSync('data/debug', { recursive: true });
await page.screenshot({ path: 'data/debug/after-continue2.png', fullPage: true });
await browser.close();
