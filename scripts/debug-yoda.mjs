import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';

const url =
  'https://passport.mykeeta.com/pc/login?locale=en&region=HK&joinkey=1101498_851697727&token_id=5oTEq210UBLUcm4tcuuy6A&service=consumer&risk_cost_id=119801&theme=longcat&cityId=810001&backurl=https%3A%2F%2Flongcat.chat%2Fapi%2Fv1%2Fuser-loginV3%3Furl%3Dhttps%253A%252F%252Flongcat.chat%252F';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(6000);
await page.getByText(/continue with email/i).first().click();
await page.waitForTimeout(2500);
const email = `testreg${Date.now()}@edu.omnnu.xyz`;
const input = page.locator('input[placeholder*="Email" i], input.oversea-input-container').first();
await input.click();
await input.pressSequentially(email, { delay: 20 });
await page.waitForTimeout(500);
await page.locator('div.submit-btn').first().click();
await page.waitForTimeout(8000);
mkdirSync('data/debug', { recursive: true });
await page.screenshot({ path: 'data/debug/yoda.png', fullPage: true });
const info = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('img')].map((img) => ({
    src: (img.src || '').slice(0, 120),
    cls: (img.className || '').toString().slice(0, 80),
    w: img.width,
    h: img.height,
    alt: img.alt,
  }));
  const yoda = [...document.querySelectorAll('[class*="yoda"], [id*="yoda"], [class*="captcha"], [class*="verify"]')].map(
    (el) => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 100),
      id: el.id,
      text: (el.innerText || '').slice(0, 100),
    })
  );
  return {
    body: (document.body.innerText || '').slice(0, 1500),
    imgs: imgs.slice(0, 40),
    yoda: yoda.slice(0, 40),
  };
});
writeFileSync('data/debug/yoda-dom.json', JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2).slice(0, 8000));
await browser.close();
