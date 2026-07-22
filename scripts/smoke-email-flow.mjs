import { chromium } from 'playwright';

const url =
  'https://passport.mykeeta.com/pc/login?locale=en&region=HK&joinkey=1101498_851697727&token_id=5oTEq210UBLUcm4tcuuy6A&service=consumer&risk_cost_id=119801&theme=longcat&cityId=810001&backurl=https%3A%2F%2Flongcat.chat%2Fapi%2Fv1%2Fuser-loginV3%3Furl%3Dhttps%253A%252F%252Flongcat.chat%252F';

const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
const apis = [];
p.on('request', (r) => {
  if (/passport\.mykeeta\.com\/api\//.test(r.url())) apis.push(r.url());
});
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForTimeout(6000);
await p.getByText(/continue with email/i).first().click();
await p.waitForTimeout(2000);
const email = `smoke${Date.now()}@edu.omnnu.xyz`;
const input = p.locator('input[placeholder*="Email" i], input.oversea-input-container').first();
await input.click();
await input.pressSequentially(email, { delay: 20 });
await p.locator('div.submit-btn').first().click();
await p.waitForTimeout(6000);
const body = (await p.locator('body').innerText()).slice(0, 400);
console.log('apis', apis);
console.log('hasYoda', /yoda|connect the dots|tap icons|shortest/i.test(body));
console.log('body', body.replace(/\n/g, ' | '));
await b.close();
