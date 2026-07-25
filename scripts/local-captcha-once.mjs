/**
 * Focused Yoda captcha test — no proxy.
 * Uses evaluate clicks (Camoufox often hangs on locator.click).
 *
 *   $env:CONFIG_PATH = (Resolve-Path data\config-local.json).Path
 *   $env:LONGCAT2API_REGISTER_HEADLESS = "0"
 *   $env:LONGCAT2API_BROWSER_ENGINE = "camoufox"
 *   node scripts/local-captcha-once.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { createAddress, isTempMailConfigured } from '../src/services/tempMail.js';
import { buildLoginPageUrl } from '../src/services/mykeetaClient.js';
import { launchBrowser, defaultContextOptions } from '../src/services/browser.js';
import { detectSlider } from '../src/services/sliderCaptcha.js';
import { solveYodaChallenge } from '../src/services/mykeetaBrowserRegister.js';
import { getCaptchaAiConfig } from '../src/services/captchaAi.js';

process.env.LONGCAT2API_REGISTER_HEADLESS = process.env.LONGCAT2API_REGISTER_HEADLESS || '0';
process.env.LONGCAT2API_BROWSER_ENGINE = process.env.LONGCAT2API_BROWSER_ENGINE || 'camoufox';

config.load();
mkdirSync('data/debug', { recursive: true });

const tm = config.getTempMail();
if (!isTempMailConfigured(tm)) {
  console.error('temp mail not configured');
  process.exit(1);
}

const ca = getCaptchaAiConfig();
console.log('[captcha] ai_ready=', ca.ready, 'model=', ca.model);

const addr = await createAddress(tm);
const email = addr.address;
console.log('[captcha] email=', email);

const launched = await launchBrowser({ headless: false, proxyUrl: null });
const { browser, engine, close } = launched;
console.log('[captcha] engine=', engine);

const context = await browser.newContext(defaultContextOptions({ engine }));
const page = await context.newPage();
// keep timeouts shorter so hangs fail fast
page.setDefaultTimeout(20000);

const logs = [];
const log = (m) => {
  logs.push(m);
  console.log('[captcha]', m);
};

const apis = [];
page.on('response', async (res) => {
  try {
    const u = res.url();
    if (!/mykeeta\.com|meituan\.net|verify\.mykeeta/i.test(u)) return;
    if (!/risk|yoda|email|verify|captcha|signup|page_data|info/i.test(u)) return;
    let body = '';
    try {
      body = (await res.text()).slice(0, 220);
    } catch {
      /* ignore */
    }
    apis.push({ s: res.status(), u: u.slice(0, 140), body });
    log(`API ${res.status()} ${u.slice(0, 100)} ${body.slice(0, 120)}`);
  } catch {
    /* ignore */
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Camoufox-safe click via DOM events */
async function domClick(selectorOrFn) {
  return page.evaluate((sel) => {
    let el = null;
    if (typeof sel === 'string') {
      el = document.querySelector(sel);
      if (!el && sel.startsWith('text:')) {
        const re = new RegExp(sel.slice(5), 'i');
        el = [...document.querySelectorAll('span,div,a,button')].find((n) =>
          re.test((n.textContent || '').trim())
        );
      }
    }
    if (!el) return false;
    el.scrollIntoView?.({ block: 'center' });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, selectorOrFn);
}

async function switchToEmail() {
  // already email?
  const hasEmail = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')];
    return inputs.some((i) => {
      const ph = (i.placeholder || '').toLowerCase();
      const t = (i.type || '').toLowerCase();
      const cls = (i.className || '').toString();
      return (
        t === 'email' ||
        ph.includes('email') ||
        (/oversea-input-container/.test(cls) && !/mobile|tel|phone/i.test(cls + ph) && t !== 'tel')
      );
    });
  });
  if (hasEmail) {
    log('already on email form');
    return;
  }

  const ok = await page.evaluate(() => {
    const el =
      document.querySelector('span.change-signin-text') ||
      [...document.querySelectorAll('span,div,a,button')].find((n) =>
        /continue with email/i.test((n.textContent || '').trim())
      );
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });
  log(ok ? 'clicked Continue with email (dom)' : 'email switch control not found');
  await sleep(1800);
}

async function fillEmailField(value) {
  // Prefer Playwright fill on a precise locator (not oversea-mobile-input)
  const loc = page
    .locator(
      'input[placeholder*="Email" i]:not([type="tel"]), input[type="email"], input.oversea-input-container:not(.oversea-mobile-input)'
    )
    .first();
  try {
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    await loc.evaluate((el) => {
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // use fill once — do NOT also keyboard.type (doubles value)
    await loc.fill(value);
  } catch {
    // pure evaluate fallback
    const ok = await page.evaluate((email) => {
      const el = [...document.querySelectorAll('input')].find((i) => {
        const ph = (i.placeholder || '').toLowerCase();
        const t = (i.type || '').toLowerCase();
        const cls = (i.className || '').toString();
        if (t === 'tel' || /mobile|phone/.test(ph + cls)) return false;
        return t === 'email' || ph.includes('email');
      });
      if (!el) return false;
      const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      el.focus();
      nativeSet ? nativeSet.call(el, email) : (el.value = email);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, value);
    if (!ok) throw new Error('email input not found after switch');
  }
  const val = await page.evaluate(() => {
    const el = [...document.querySelectorAll('input')].find(
      (i) => (i.placeholder || '').toLowerCase().includes('email') || i.type === 'email'
    );
    return el?.value || '';
  });
  log(`email value=${val}`);
  if (val !== value) {
    // last resort: clear + type only
    await loc.click({ force: true, timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(value, { delay: 25 });
    const val2 = await page.evaluate(() => {
      const el = [...document.querySelectorAll('input')].find(
        (i) => (i.placeholder || '').toLowerCase().includes('email') || i.type === 'email'
      );
      return el?.value || '';
    });
    log(`email value after type=${val2}`);
  }
}

async function clickSubmit() {
  const ok = await page.evaluate(() => {
    const el =
      document.querySelector('div.submit-btn') ||
      [...document.querySelectorAll('div,button,span')].find(
        (n) => (n.textContent || '').trim() === 'Continue' && n.children.length <= 1
      );
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });
  log(ok ? 'submitted (dom)' : 'submit btn missing');
}

const out = { ok: false, engine, email, logs, apis, error: '' };

try {
  const url = buildLoginPageUrl();
  log(`goto ${url.slice(0, 100)}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(6000);
  // wait H5guard-ish globals
  await page
    .waitForFunction(() => window.H5guard || window.TokenStandardization, null, { timeout: 15000 })
    .catch(() => log('H5guard not seen (continue)'));

  await switchToEmail();
  await sleep(800);
  await fillEmailField(email);
  await sleep(500);
  await clickSubmit();
  // sometimes first submit only validates field — click again if no risk api
  await sleep(2000);
  const riskSeen = apis.some((a) => /userrisk|signupapply/i.test(a.u));
  if (!riskSeen) {
    log('no risk api yet — submit again');
    await clickSubmit();
  }

  // Wait Yoda
  let yoda = false;
  for (let i = 0; i < 30; i++) {
    await sleep(800);
    const body = await page.locator('body').innerText().catch(() => '');
    const yodaDom = await page
      .locator('#yodaVerify, .yoda-verify-container, .yoda-global-inference-wrapper')
      .first()
      .isVisible()
      .catch(() => false);
    const det = await detectSlider(page);
    if (
      yodaDom ||
      det ||
      /move the slider|complete the puzzle|tap icons|following order|connect the dots|shortest line/i.test(body)
    ) {
      yoda = true;
      log(
        `yoda at ${((i + 1) * 0.8).toFixed(1)}s det=${!!det} yodaDom=${yodaDom} body=${body.replace(/\s+/g, ' ').slice(0, 100)}`
      );
      break;
    }
    if (/verification code|enter verification/i.test(body)) {
      log('OTP UI without captcha');
      out.ok = true;
      out.detail = 'otp_no_captcha';
      break;
    }
    if (/Unusual activity/i.test(body)) throw new Error('Unusual activity');
  }

  if (out.detail === 'otp_no_captcha') {
    // ok
  } else if (!yoda) {
    await page.screenshot({ path: 'data/debug/captcha-no-yoda.png', fullPage: true }).catch(() => {});
    throw new Error('no yoda challenge in ~24s');
  } else {
    await page.screenshot({ path: 'data/debug/captcha-before.png' }).catch(() => {});
    // mouse path uses page.mouse — works even when locator.click hangs
    const r = await solveYodaChallenge(page, log);
    out.yoda = r;
    await page.screenshot({ path: 'data/debug/captcha-after.png' }).catch(() => {});
    const body = await page.locator('body').innerText().catch(() => '');
    out.bodyTail = body.slice(0, 400);
    const otp = /verification code|enter verification/i.test(body);
    if (r?.handled && !r.error) out.ok = true;
    if (otp) out.ok = true;
    out.detail = r?.method || r?.error || (otp ? 'otp' : 'unknown');
    log(`result ok=${out.ok} detail=${out.detail} handled=${r?.handled}`);
  }
} catch (e) {
  out.error = e.message;
  log(`ERROR ${e.message}`);
  await page.screenshot({ path: 'data/debug/captcha-error.png', fullPage: true }).catch(() => {});
} finally {
  await context.close().catch(() => {});
  await close();
}

writeFileSync('data/debug/captcha-once.json', JSON.stringify(out, null, 2));
console.log(
  '\n===',
  JSON.stringify({ ok: out.ok, detail: out.detail, error: out.error, yoda: out.yoda }, null, 2)
);
process.exit(out.ok ? 0 : 2);
