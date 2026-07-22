/**
 * Full-auto LongCat overseas email registration via Playwright.
 *
 * H5Guard cannot be bypassed with bare HTTP — browser loads real hooks.
 * AI captcha (captchaAi) is **last resort only** after UI retries fail.
 *
 * Slow network: long waits / high timeouts (LongCat & mykeeta are often slow).
 */

import { chromium } from 'playwright';
import { config } from '../config.js';
import { createAddress, isTempMailConfigured, waitForCode } from './tempMail.js';
import { buildLoginPageUrl, MYKEETA } from './mykeetaClient.js';
import { getProxyUrl, startProxy, proxyStatus, rotateProxy } from './proxyPool.js';
import { getCaptchaAiConfig, solveCaptchaWithAi } from './captchaAi.js';

/** Slow-site defaults (override via env) */
const SLOW = {
  gotoMs: envInt('LONGCAT2API_REG_GOTO_MS', 120000),
  actionMs: envInt('LONGCAT2API_REG_ACTION_MS', 45000),
  h5guardMs: envInt('LONGCAT2API_REG_H5GUARD_MS', 8000),
  afterClickMs: envInt('LONGCAT2API_REG_AFTER_CLICK_MS', 5000),
  otpUiMs: envInt('LONGCAT2API_REG_OTP_UI_MS', 90000),
  redirectMs: envInt('LONGCAT2API_REG_REDIRECT_MS', 120000),
  totalMs: envInt('LONGCAT2API_REGISTER_TIMEOUT_MS', 420000),
  otpDefaultSec: envInt('LONGCAT2API_REGISTER_OTP_TIMEOUT', 240),
};

function envInt(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
}

function log(fn, msg) {
  const line = `[MykeetaReg] ${msg}`;
  console.log(line);
  if (typeof fn === 'function') fn(msg);
}

function randomPassword(len = 14) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#';
  let s = '';
  for (let i = 0; i < len; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

async function ensureProxy(onLog) {
  const pp = config.getProxyPool();
  if (!pp.enabled) {
    log(onLog, 'proxy_pool disabled — browser uses direct egress (must be non-CN for register)');
    return null;
  }
  try {
    if (proxyStatus().status !== 'running') {
      log(onLog, 'starting sing-box proxy pool...');
      await startProxy({ pickRandom: true });
    } else {
      await rotateProxy();
    }
    const url = getProxyUrl();
    log(onLog, `proxy ready: ${url}`);
    return url;
  } catch (e) {
    log(onLog, `proxy failed: ${e.message}; continuing direct`);
    return null;
  }
}

function toPlaywrightProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    return { server: `${u.protocol}//${u.host}` };
  } catch {
    return { server: proxyUrl };
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function clickContinue(page) {
  const candidates = [
    page.getByRole('button', { name: /continue|继续|下一步|next|sign up|log in|登录|注册/i }),
    page.locator('button:has-text("Continue")'),
    page.locator('button:has-text("继续")'),
    page.locator('.set-password-continue-btn'),
    page.locator('button[type="submit"]'),
  ];
  for (const loc of candidates) {
    try {
      if (await loc.count()) {
        const el = loc.first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.click({ timeout: SLOW.actionMs });
          return true;
        }
      }
    } catch {
      /* next */
    }
  }
  await page.keyboard.press('Enter');
  return false;
}

async function fillEmail(page, email) {
  const sels = [
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="email"]',
    '.login-email-input-container input',
    '.login-input input',
    'input[type="text"]',
  ];
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) && (await loc.isVisible({ timeout: 3000 }))) {
        await loc.click({ timeout: SLOW.actionMs });
        await loc.fill('');
        await loc.pressSequentially(email, { delay: 40 });
        return true;
      }
    } catch {
      /* next */
    }
  }
  throw new Error('email input not found on mykeeta login page');
}

async function fillOtp(page, code) {
  const sels = [
    'input[inputmode="numeric"]',
    '.verify-code-input input',
    '.pc-login-verify-code-container input',
    'input[maxlength="6"]',
    'input[type="tel"]',
  ];
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) && (await loc.isVisible({ timeout: 2000 }))) {
        await loc.click({ timeout: SLOW.actionMs });
        await loc.fill(String(code));
        return true;
      }
    } catch {
      /* next */
    }
  }
  const boxes = page.locator('input[maxlength="1"]');
  const n = await boxes.count();
  if (n >= 4) {
    const digits = String(code).split('');
    for (let i = 0; i < Math.min(n, digits.length); i++) {
      await boxes.nth(i).fill(digits[i]);
    }
    return true;
  }
  throw new Error('OTP input not found');
}

function cookiesToHeader(cookies) {
  const domains = ['longcat.chat', 'mykeeta.com', 'meituan.com'];
  const map = new Map();
  for (const c of cookies) {
    if (domains.some((d) => (c.domain || '').includes(d))) {
      map.set(c.name, c.value);
    }
  }
  return {
    header: [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    passport_token: map.get('passport_token_key') || '',
    lxsdk_cuid: map.get('_lxsdk_cuid') || '',
    lxsdk_s: map.get('_lxsdk_s') || '',
  };
}

function looksLikeYoda(text) {
  return /yoda|slider|slide to|security verification|安全验证|拖动|滑块|拼图|verify you are human/i.test(
    text || ''
  );
}

function looksLikeImageCaptcha(text) {
  return /captcha|验证码|enter the code|picture|图形/i.test(text || '');
}

/**
 * Try non-AI handling first; AI only as last resort.
 */
async function trySolveChallenge(page, onLog) {
  const body = await page.locator('body').innerText().catch(() => '');
  const hasYoda = looksLikeYoda(body);
  const hasImg = looksLikeImageCaptcha(body);

  // 1) Wait — challenge may auto-dismiss on slow networks
  if (hasYoda || hasImg) {
    log(onLog, 'challenge UI detected — wait 8s (no AI yet)...');
    await sleep(8000);
    const body2 = await page.locator('body').innerText().catch(() => '');
    if (!looksLikeYoda(body2) && !looksLikeImageCaptcha(body2)) {
      log(onLog, 'challenge cleared without AI');
      return { handled: true, method: 'wait' };
    }
  } else {
    return { handled: false };
  }

  // 2) Manual-ish: try common close / refresh buttons
  try {
    const refresh = page.getByRole('button', { name: /refresh|reload|换一张|刷新/i }).first();
    if (await refresh.isVisible({ timeout: 1500 })) {
      await refresh.click();
      await sleep(3000);
    }
  } catch {
    /* ignore */
  }

  // 3) LAST RESORT: AI vision
  const ca = getCaptchaAiConfig();
  if (!ca.ready) {
    log(onLog, 'AI captcha not configured — cannot solve challenge');
    return { handled: false, error: 'challenge present; captcha_ai disabled' };
  }

  log(onLog, 'AI captcha fallback (last resort)...');
  const shot = await page.screenshot({ type: 'png', fullPage: false });

  if (hasYoda && !hasImg) {
    // Slider: AI estimates ratio, then drag
    const ai = await solveCaptchaWithAi(shot, { kind: 'slider', contentType: 'image/png' });
    if (!ai.ok || ai.ratio == null) {
      return { handled: false, error: `AI slider failed: ${ai.error || 'no ratio'}` };
    }
    log(onLog, `AI slider ratio=${ai.ratio}`);
    const slider = page
      .locator(
        '[class*="slider"] .slider-btn, [class*="yoda"] .slider, .yoda-slider-btn, .slide-verify-slider-mask-item, .handler'
      )
      .first();
    try {
      if (await slider.isVisible({ timeout: 3000 })) {
        const box = await slider.boundingBox();
        const track = page.locator('[class*="slider"], [class*="slide-verify"]').first();
        const trackBox = (await track.boundingBox().catch(() => null)) || box;
        if (box && trackBox) {
          const dist = Math.max(40, (trackBox.width || 300) * ai.ratio - box.width / 2);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + dist, box.y + box.height / 2, { steps: 28 });
          await sleep(200);
          await page.mouse.up();
          await sleep(4000);
          log(onLog, 'AI slider drag done');
          return { handled: true, method: 'ai_slider' };
        }
      }
    } catch (e) {
      return { handled: false, error: `slider drag failed: ${e.message}` };
    }
  }

  // Image captcha: find img + input
  const ai = await solveCaptchaWithAi(shot, { kind: 'image', contentType: 'image/png' });
  if (!ai.ok || !ai.code) {
    return { handled: false, error: `AI image captcha failed: ${ai.error || 'empty'}` };
  }
  log(onLog, `AI image code=${ai.code}`);
  const input = page
    .locator(
      'input[name*="captcha" i], input[placeholder*="code" i], input[placeholder*="验证" i], .captcha input'
    )
    .first();
  try {
    if (await input.isVisible({ timeout: 3000 })) {
      await input.fill(ai.code);
      await clickContinue(page);
      await sleep(4000);
      return { handled: true, method: 'ai_image' };
    }
  } catch (e) {
    return { handled: false, error: `fill captcha failed: ${e.message}` };
  }
  return { handled: false, error: 'captcha input not found for AI code' };
}

/**
 * Watch network for email apply success to know OTP was requested.
 */
function attachNetworkWatch(page, state) {
  page.on('response', async (res) => {
    try {
      const u = res.url();
      if (!/emaillogin|emailsignup|userriskcheck|yoda/i.test(u)) return;
      const status = res.status();
      let body = '';
      try {
        body = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      state.apiLogs.push({ u: u.slice(0, 120), status, body: body.slice(0, 200) });
      if (/emailloginapply|emailsignupapply/i.test(u) && status >= 200 && status < 300) {
        if (!/error|fail/i.test(body) || /serialNumber|serial_number|ticket/i.test(body)) {
          state.applyOk = true;
        }
      }
      if (status === 403) state.got403 = true;
    } catch {
      /* ignore */
    }
  });
}

/**
 * Full auto register one account.
 */
export async function registerOneAccount({ onLog, timeoutMs = SLOW.totalMs } = {}) {
  const tm = config.getTempMail();
  if (!isTempMailConfigured(tm)) {
    throw new Error('临时邮箱未配置');
  }

  const password = randomPassword();
  log(onLog, 'creating temp mailbox...');
  const addr = await createAddress(tm);
  const email = addr.address;
  const mailJwt = addr.jwt;
  log(onLog, `mailbox: ${email}`);

  const proxyUrl = await ensureProxy(onLog);
  const loginUrl = buildLoginPageUrl();
  log(onLog, `open ${loginUrl} (slow-site timeouts goto=${SLOW.gotoMs}ms total=${timeoutMs}ms)`);

  const headless = process.env.LONGCAT2API_REGISTER_HEADLESS !== '0';
  // K8s readOnlyRootFilesystem: ensure /tmp parents exist before chromium mkdtemp
  const { mkdirSync } = await import('node:fs');
  for (const d of ['/tmp', '/tmp/playwright-artifacts', process.env.TMPDIR, process.env.HOME].filter(
    Boolean
  )) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  let browser;
  try {
    browser = await chromium.launch({
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
      ],
      proxy: toPlaywrightProxy(proxyUrl),
      timeout: SLOW.gotoMs,
    });
  } catch (e) {
    throw new Error(
      `Playwright chromium launch failed: ${e.message}. ` +
        `Need Chromium in image + writable /tmp (PLAYWRIGHT_BROWSERS_PATH).`
    );
  }

  const context = await browser.newContext({
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(SLOW.actionMs);
  page.setDefaultNavigationTimeout(SLOW.gotoMs);

  const net = { apiLogs: [], applyOk: false, got403: false };
  attachNetworkWatch(page, net);

  const deadline = Date.now() + timeoutMs;
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: SLOW.gotoMs });
    log(onLog, `waiting H5guard init ${SLOW.h5guardMs}ms...`);
    await sleep(SLOW.h5guardMs);
    // Wait for token standard if present
    await page
      .waitForFunction(
        () => window.H5guard || window.TokenStandardization || window.__TOKEN_STANDARD_INTERCEPTOR__,
        null,
        { timeout: 30000 }
      )
      .catch(() => log(onLog, 'H5guard global not detected (continue anyway)'));

    log(onLog, `page title: ${await page.title()}`);

    try {
      await page.getByRole('button', { name: /accept|agree|ok|got it/i }).first().click({ timeout: 3000 });
    } catch {
      /* ignore */
    }

    // Switch to email tab if mobile is default
    try {
      const emailTab = page.getByText(/email|邮箱|e-mail/i).first();
      if (await emailTab.isVisible({ timeout: 3000 })) {
        await emailTab.click();
        await sleep(1000);
      }
    } catch {
      /* ignore */
    }

    log(onLog, 'fill email...');
    await fillEmail(page, email);
    await sleep(800);
    await clickContinue(page);
    await sleep(SLOW.afterClickMs);

    // Challenge? try wait first, AI last
    let ch = await trySolveChallenge(page, onLog);
    if (ch.error) log(onLog, `challenge: ${ch.error}`);

    // Retry continue once if still on email page
    const stillEmail = await page.locator('.login-email-input-container input, input[type="email"]').isVisible().catch(() => false);
    if (stillEmail) {
      log(onLog, 'still on email step — click continue again (slow UI)...');
      await clickContinue(page);
      await sleep(SLOW.afterClickMs);
      ch = await trySolveChallenge(page, onLog);
    }

    log(onLog, `network: applyOk=${net.applyOk} got403=${net.got403} logs=${net.apiLogs.length}`);
    if (net.apiLogs.length) {
      for (const L of net.apiLogs.slice(-6)) {
        log(onLog, `  api ${L.status} ${L.u} ${L.body.slice(0, 80)}`);
      }
    }

    // Wait OTP UI longer
    log(onLog, `waiting for OTP UI (up to ${SLOW.otpUiMs}ms)...`);
    const otpVisible = await page
      .waitForSelector(
        '.pc-login-verify-code-container, .verify-code-input, input[inputmode="numeric"], input[maxlength="6"], input[maxlength="1"]',
        { timeout: SLOW.otpUiMs }
      )
      .then(() => true)
      .catch(() => false);

    if (!otpVisible) {
      // One more challenge attempt
      await trySolveChallenge(page, onLog);
      const otp2 = await page
        .waitForSelector(
          '.pc-login-verify-code-container, .verify-code-input, input[inputmode="numeric"]',
          { timeout: 30000 }
        )
        .then(() => true)
        .catch(() => false);
      if (!otp2) {
        const snap = await page.screenshot({ type: 'png' }).catch(() => null);
        throw new Error(
          `OTP UI not shown (applyOk=${net.applyOk} 403=${net.got403}). ` +
            `Page may still be loading or blocked. url=${page.url()}` +
            (snap ? ` screenshot_bytes=${snap.length}` : '')
        );
      }
    }

    const otpTimeout = Math.min(
      (Number(tm.otp_timeout) || SLOW.otpDefaultSec) * 1000,
      Math.max(60000, deadline - Date.now() - 60000)
    );
    log(onLog, `waiting email OTP (timeout ${Math.floor(otpTimeout / 1000)}s, long wait OK)...`);
    const code = await waitForCode(tm, mailJwt, {
      timeout: otpTimeout,
      pollInterval: 4000,
    });
    log(onLog, `got OTP: ${code}`);

    await fillOtp(page, code);
    await sleep(600);
    await clickContinue(page);
    await sleep(SLOW.afterClickMs);

    // Optional challenge after OTP
    await trySolveChallenge(page, onLog);

    // Optional set-password
    try {
      const pwd = page
        .locator('.signup-password-input-container input, .password-input input, input[type="password"]')
        .first();
      if ((await pwd.count()) && (await pwd.isVisible({ timeout: 8000 }))) {
        log(onLog, 'set password page...');
        await pwd.fill(password);
        const pwd2 = page.locator('input[type="password"]').nth(1);
        if ((await pwd2.count()) && (await pwd2.isVisible())) {
          await pwd2.fill(password);
        }
        await clickContinue(page);
        await sleep(SLOW.afterClickMs);
      }
    } catch {
      /* no password step */
    }

    log(onLog, `waiting longcat redirect (up to ${SLOW.redirectMs}ms)...`);
    await page
      .waitForURL(/longcat\.chat/, { timeout: Math.min(SLOW.redirectMs, Math.max(15000, deadline - Date.now())) })
      .catch(async () => {
        await sleep(8000);
      });

    if (!page.url().includes('longcat.chat')) {
      log(onLog, `still on ${page.url()}, goto longcat home (slow)...`);
      await page.goto('https://longcat.chat/', {
        waitUntil: 'domcontentloaded',
        timeout: SLOW.gotoMs,
      });
    }
    await sleep(4000);

    let parsed = cookiesToHeader(await context.cookies());
    if (!parsed.passport_token) {
      log(onLog, 'no passport_token yet — open /t and wait...');
      await page.goto('https://longcat.chat/t', {
        waitUntil: 'domcontentloaded',
        timeout: SLOW.gotoMs,
      });
      await sleep(5000);
      parsed = cookiesToHeader(await context.cookies());
    }
    if (!parsed.passport_token) {
      throw new Error(
        `no passport_token_key after login (url=${page.url()} cookies=${(await context.cookies())
          .map((c) => c.name)
          .join(',')})`
      );
    }

    log(onLog, `success passport_token_key=${parsed.passport_token.slice(0, 8)}...`);
    return {
      ok: true,
      email,
      password,
      mail_jwt: mailJwt,
      cookie: parsed.header,
      passport_token: parsed.passport_token,
      lxsdk_cuid: parsed.lxsdk_cuid,
      lxsdk_s: parsed.lxsdk_s,
      detail: `registered via mykeeta browser; final_url=${page.url()}`,
      mykeeta: MYKEETA.origin,
    };
  } finally {
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
}
