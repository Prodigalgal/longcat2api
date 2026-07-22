/**
 * Full-auto LongCat overseas email registration via Playwright.
 *
 * Critical UI facts (reverse-engineered 2026-07):
 *  - Default view is **phone** login, not email.
 *  - Must click **「Continue with email」** first.
 *  - Email field: input[placeholder*="Email"] / input.oversea-input-container
 *  - Submit is **div.submit-btn** (NOT <button>).
 *  - After submit, Yoda **sudoku/connect-dots** often appears (canvas.sudoku-canvas).
 *  - Bare HTTP → 403; browser loads H5Guard.
 *  - AI captcha is last-resort only for Yoda after wait.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { createAddress, isTempMailConfigured, waitForCode } from './tempMail.js';
import { buildLoginPageUrl, MYKEETA } from './mykeetaClient.js';
import { getProxyUrl, startProxy, proxyStatus, rotateProxy } from './proxyPool.js';
import { getCaptchaAiConfig, solveCaptchaWithAi, solveYodaSudokuWithAi } from './captchaAi.js';

const SLOW = {
  gotoMs: envInt('LONGCAT2API_REG_GOTO_MS', 120000),
  actionMs: envInt('LONGCAT2API_REG_ACTION_MS', 45000),
  h5guardMs: envInt('LONGCAT2API_REG_H5GUARD_MS', 8000),
  afterClickMs: envInt('LONGCAT2API_REG_AFTER_CLICK_MS', 6000),
  otpUiMs: envInt('LONGCAT2API_REG_OTP_UI_MS', 120000),
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

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function ensureProxy(onLog) {
  const pp = config.getProxyPool();
  if (!pp.enabled) {
    log(onLog, 'proxy_pool disabled — direct egress (prefer non-CN)');
    return null;
  }
  try {
    if (proxyStatus().status !== 'running') {
      log(onLog, 'starting sing-box...');
      await startProxy({ pickRandom: true });
    } else {
      await rotateProxy();
    }
    const url = getProxyUrl();
    log(onLog, `proxy ready: ${url}`);
    return url;
  } catch (e) {
    log(onLog, `proxy failed: ${e.message}; direct`);
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

function cookiesToHeader(cookies) {
  const domains = ['longcat.chat', 'mykeeta.com', 'meituan.com'];
  const map = new Map();
  for (const c of cookies) {
    if (domains.some((d) => (c.domain || '').includes(d))) map.set(c.name, c.value);
  }
  return {
    header: [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    passport_token: map.get('passport_token_key') || '',
    lxsdk_cuid: map.get('_lxsdk_cuid') || '',
    lxsdk_s: map.get('_lxsdk_s') || '',
  };
}

function attachNetworkWatch(page, state) {
  page.on('response', async (res) => {
    try {
      const u = res.url();
      if (!/passport\.mykeeta\.com\/api\//i.test(u)) return;
      const status = res.status();
      let body = '';
      try {
        body = (await res.text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      state.apiLogs.push({ u: u.slice(0, 160), status, body: body.slice(0, 240) });
      if (/userriskcheck/i.test(u) && status >= 200 && status < 300) state.riskOk = true;
      if (/emailloginapply|emailsignupapply/i.test(u) && status >= 200 && status < 300) {
        if (/serialNumber|serial_number/i.test(body) || !/"error"\s*:/.test(body)) state.applyOk = true;
      }
      if (status === 403) state.got403 = true;
    } catch {
      /* ignore */
    }
  });
}

/** Switch from default phone UI to email UI */
async function switchToEmail(page, onLog) {
  const body = await page.locator('body').innerText().catch(() => '');
  if (/email address|邮箱/i.test(body) && !/continue with email/i.test(body)) {
    log(onLog, 'already on email form');
    return;
  }
  const candidates = [
    page.getByText(/continue with email/i),
    page.getByText(/邮箱登录|使用邮箱|邮件/i),
    page.locator('text=Continue with email'),
  ];
  for (const loc of candidates) {
    try {
      if (await loc.first().isVisible({ timeout: 3000 })) {
        await loc.first().click({ timeout: 10000 });
        log(onLog, 'clicked Continue with email');
        await sleep(2500);
        return;
      }
    } catch {
      /* next */
    }
  }
  // Fallback: if phone inputs visible, must switch
  const phone = page.locator('input[type="tel"], .oversea-mobile-input');
  if (await phone.first().isVisible().catch(() => false)) {
    throw new Error('phone login UI still shown; cannot find Continue with email');
  }
}

async function fillEmail(page, email, onLog) {
  const sels = [
    'input[placeholder*="Email" i]',
    'input[placeholder*="email" i]',
    'input.oversea-input-container',
    'input[type="email"]',
    'input[type="text"]',
  ];
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) && (await loc.isVisible({ timeout: 4000 }))) {
        // skip country code field
        const ph = (await loc.getAttribute('placeholder')) || '';
        const cls = (await loc.getAttribute('class')) || '';
        if (/mobile|code-input|tel/i.test(cls) && !/email/i.test(ph + cls)) continue;
        await loc.click({ timeout: 10000 });
        await loc.fill('');
        await loc.pressSequentially(email, { delay: 35 });
        // dispatch input events for React
        await loc.evaluate((el, v) => {
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, email);
        log(onLog, `filled email via ${sel}`);
        return true;
      }
    } catch {
      /* next */
    }
  }
  throw new Error('email input not found (did switchToEmail run?)');
}

/** Submit is div.submit-btn, not a real <button> */
async function clickSubmitContinue(page, onLog) {
  const strategies = [
    async () => {
      const btn = page.locator('div.submit-btn').first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click({ force: true });
        return 'div.submit-btn';
      }
      return null;
    },
    async () => {
      const btn = page.getByText('Continue', { exact: true }).last();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click({ force: true });
        return 'text=Continue exact';
      }
      return null;
    },
    async () => {
      await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('div.submit-btn, div, span, button')];
        const el =
          nodes.find((n) => n.classList?.contains('submit-btn')) ||
          nodes.find((n) => (n.innerText || '').trim() === 'Continue' && n.children.length === 0);
        if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      return 'evaluate click';
    },
  ];
  for (const s of strategies) {
    try {
      const name = await s();
      if (name) {
        log(onLog, `submit via ${name}`);
        return true;
      }
    } catch (e) {
      log(onLog, `submit strategy fail: ${e.message}`);
    }
  }
  return false;
}

async function waitCanvasReady(page) {
  const canvas = page.locator('canvas.sudoku-canvas, .sudoku-image canvas, canvas').first();
  for (let i = 0; i < 20; i++) {
    if (await canvas.isVisible().catch(() => false)) {
      const loading = page.locator('.sudoku-loading, text=Loading');
      const still = await loading.isVisible().catch(() => false);
      if (!still) return canvas;
    }
    await sleep(500);
  }
  return canvas;
}

/**
 * Yoda connect-dots / sudoku: wait first; AI last resort.
 * AI returns POINTS as x,y ratios relative to canvas.
 */
async function trySolveYoda(page, onLog) {
  const body = await page.locator('body').innerText().catch(() => '');
  const yodaVisible = await page.locator('#yodaVerify, .yoda-verify-container, .yoda-sudoku-wrap, .sudoku-canvas').first().isVisible().catch(() => false);
  if (!yodaVisible && !/tap icons|connect the dots|shortest line|安全验证|yoda/i.test(body)) {
    return { handled: false };
  }

  log(onLog, 'Yoda challenge detected — wait 5s (no AI yet)...');
  await sleep(5000);
  const still = await page.locator('#yodaVerify, .yoda-sudoku-wrap, canvas.sudoku-canvas').first().isVisible().catch(() => false);
  if (!still) {
    log(onLog, 'Yoda gone without AI');
    return { handled: true, method: 'wait' };
  }

  // refresh once (non-AI)
  try {
    const refresh = page.locator('.sudoku-operate-refresh, img[alt="refresh"]').first();
    if (await refresh.isVisible({ timeout: 1500 })) {
      await refresh.click();
      log(onLog, 'clicked yoda refresh');
      await sleep(4000);
    }
  } catch {
    /* ignore */
  }

  const ca = getCaptchaAiConfig();
  if (!ca.ready) {
    return { handled: false, error: 'Yoda present; captcha_ai not enabled (last-resort only)' };
  }

  const canvas = await waitCanvasReady(page);
  if (!(await canvas.isVisible().catch(() => false))) {
    return { handled: false, error: 'Yoda canvas not ready' };
  }

  log(onLog, 'AI captcha fallback for Yoda sudoku (last resort)...');
  const box = await canvas.boundingBox();
  const shot = await page
    .locator('.yoda-modal-content, .yoda-sudoku-wrap, #yodaVerify')
    .first()
    .screenshot({ type: 'png' })
    .catch(() => page.screenshot({ type: 'png' }));

  const ai = await solveYodaSudokuWithAi(shot);
  if (!ai.ok || !ai.points?.length) {
    log(onLog, `AI sudoku parse: ${ai.error || ai.raw || 'no points'}`);
    return { handled: false, error: `AI could not extract connect-dot points: ${ai.error || ''}` };
  }
  const points = ai.points;

  if (!box) return { handled: false, error: 'no canvas box' };
  log(onLog, `AI points=${JSON.stringify(points)}`);
  for (const [rx, ry] of points) {
    const x = box.x + Math.min(0.98, Math.max(0.02, rx)) * box.width;
    const y = box.y + Math.min(0.98, Math.max(0.02, ry)) * box.height;
    await page.mouse.click(x, y);
    await sleep(350);
  }
  await sleep(5000);
  const gone = !(await page.locator('.yoda-sudoku-wrap, canvas.sudoku-canvas').first().isVisible().catch(() => false));
  if (gone) {
    log(onLog, 'Yoda cleared after AI clicks');
    return { handled: true, method: 'ai_sudoku' };
  }
  return { handled: false, error: 'Yoda still visible after AI clicks' };
}

async function fillOtp(page, code, onLog) {
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
        await loc.click();
        await loc.fill(String(code));
        log(onLog, `OTP filled via ${sel}`);
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
    for (let i = 0; i < Math.min(n, digits.length); i++) await boxes.nth(i).fill(digits[i]);
    log(onLog, 'OTP filled multi-box');
    return true;
  }
  throw new Error('OTP input not found');
}

/**
 * Full auto register one account.
 */
export async function registerOneAccount({ onLog, timeoutMs = SLOW.totalMs } = {}) {
  const tm = config.getTempMail();
  if (!isTempMailConfigured(tm)) throw new Error('临时邮箱未配置');

  const password = randomPassword();
  log(onLog, 'creating temp mailbox...');
  const addr = await createAddress(tm);
  const email = addr.address;
  const mailJwt = addr.jwt;
  log(onLog, `mailbox: ${email}`);

  const proxyUrl = await ensureProxy(onLog);
  const loginUrl = buildLoginPageUrl();
  log(onLog, `open ${loginUrl}`);

  for (const d of ['/tmp', '/tmp/playwright-artifacts', process.env.TMPDIR, process.env.HOME].filter(Boolean)) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  const headless = process.env.LONGCAT2API_REGISTER_HEADLESS !== '0';
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
    throw new Error(`Playwright launch failed: ${e.message}`);
  }

  const context = await browser.newContext({
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(SLOW.actionMs);
  page.setDefaultNavigationTimeout(SLOW.gotoMs);

  const net = { apiLogs: [], applyOk: false, got403: false, riskOk: false };
  attachNetworkWatch(page, net);
  const deadline = Date.now() + timeoutMs;

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: SLOW.gotoMs });
    log(onLog, `waiting H5guard ${SLOW.h5guardMs}ms...`);
    await sleep(SLOW.h5guardMs);
    await page
      .waitForFunction(
        () => window.H5guard || window.TokenStandardization || window.__TOKEN_STANDARD_INTERCEPTOR__,
        null,
        { timeout: 30000 }
      )
      .catch(() => log(onLog, 'H5guard global not detected (continue)'));

    log(onLog, `page title: ${await page.title()}`);

    // *** critical: leave phone UI ***
    await switchToEmail(page, onLog);
    await fillEmail(page, email, onLog);
    await sleep(1000);

    // Submit email
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(onLog, `submit continue attempt ${attempt}/3...`);
      await clickSubmitContinue(page, onLog);
      await sleep(SLOW.afterClickMs);

      // Yoda after submit?
      const y = await trySolveYoda(page, onLog);
      if (y.error) log(onLog, `yoda: ${y.error}`);
      if (y.handled) {
        await sleep(3000);
        // may need submit again after yoda
        if (!(await page.locator('input[inputmode="numeric"], .verify-code-input input, input[maxlength="6"]').first().isVisible().catch(() => false))) {
          await clickSubmitContinue(page, onLog);
          await sleep(SLOW.afterClickMs);
        }
      }

      if (net.riskOk || net.applyOk) break;
      const otp = await page
        .locator('input[inputmode="numeric"], .verify-code-input input, input[maxlength="6"], .pc-login-verify-code-container')
        .first()
        .isVisible()
        .catch(() => false);
      if (otp) break;
    }

    log(onLog, `network riskOk=${net.riskOk} applyOk=${net.applyOk} 403=${net.got403} logs=${net.apiLogs.length}`);
    for (const L of net.apiLogs.slice(-8)) {
      log(onLog, `  api ${L.status} ${L.u} ${L.body.slice(0, 100)}`);
    }

    log(onLog, `waiting OTP UI up to ${SLOW.otpUiMs}ms...`);
    const otpVisible = await page
      .waitForSelector(
        'input[inputmode="numeric"], .verify-code-input input, .pc-login-verify-code-container input, input[maxlength="6"], input[maxlength="1"]',
        { timeout: SLOW.otpUiMs }
      )
      .then(() => true)
      .catch(() => false);

    if (!otpVisible) {
      await trySolveYoda(page, onLog);
      const otp2 = await page
        .waitForSelector('input[inputmode="numeric"], input[maxlength="6"], .verify-code-input input', {
          timeout: 30000,
        })
        .then(() => true)
        .catch(() => false);
      if (!otp2) {
        throw new Error(
          `OTP UI not shown (riskOk=${net.riskOk} applyOk=${net.applyOk} 403=${net.got403}). url=${page.url()}`
        );
      }
    }

    const otpTimeout = Math.min(
      (Number(tm.otp_timeout) || SLOW.otpDefaultSec) * 1000,
      Math.max(60000, deadline - Date.now() - 60000)
    );
    log(onLog, `waiting email OTP (${Math.floor(otpTimeout / 1000)}s)...`);
    const code = await waitForCode(tm, mailJwt, { timeout: otpTimeout, pollInterval: 4000 });
    log(onLog, `got OTP: ${code}`);
    await fillOtp(page, code, onLog);
    await sleep(600);
    await clickSubmitContinue(page, onLog);
    await sleep(SLOW.afterClickMs);
    await trySolveYoda(page, onLog);

    // optional password
    try {
      const pwd = page.locator('input[type="password"]').first();
      if (await pwd.isVisible({ timeout: 8000 })) {
        log(onLog, 'set password...');
        await pwd.fill(password);
        const pwd2 = page.locator('input[type="password"]').nth(1);
        if (await pwd2.isVisible().catch(() => false)) await pwd2.fill(password);
        await clickSubmitContinue(page, onLog);
        await sleep(SLOW.afterClickMs);
      }
    } catch {
      /* none */
    }

    log(onLog, 'waiting longcat redirect...');
    await page
      .waitForURL(/longcat\.chat/, {
        timeout: Math.min(SLOW.redirectMs, Math.max(20000, deadline - Date.now())),
      })
      .catch(async () => sleep(8000));

    if (!page.url().includes('longcat.chat')) {
      log(onLog, `goto longcat home from ${page.url()}`);
      await page.goto('https://longcat.chat/', { waitUntil: 'domcontentloaded', timeout: SLOW.gotoMs });
    }
    await sleep(4000);

    let parsed = cookiesToHeader(await context.cookies());
    if (!parsed.passport_token) {
      await page.goto('https://longcat.chat/t', { waitUntil: 'domcontentloaded', timeout: SLOW.gotoMs });
      await sleep(5000);
      parsed = cookiesToHeader(await context.cookies());
    }
    if (!parsed.passport_token) {
      throw new Error(`no passport_token_key (url=${page.url()})`);
    }

    log(onLog, `SUCCESS token=${parsed.passport_token.slice(0, 8)}...`);
    return {
      ok: true,
      email,
      password,
      mail_jwt: mailJwt,
      cookie: parsed.header,
      passport_token: parsed.passport_token,
      lxsdk_cuid: parsed.lxsdk_cuid,
      lxsdk_s: parsed.lxsdk_s,
      detail: `registered; url=${page.url()}`,
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
