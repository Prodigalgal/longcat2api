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
import { getCaptchaAiConfig, solveYodaSudokuWithAi } from './captchaAi.js';
import { detectSlider, solveSliderTraditional } from './sliderCaptcha.js';

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
  const canvas = page.locator('canvas.sudoku-canvas, .sudoku-image canvas, .yoda-sudoku-wrap canvas, canvas').first();
  for (let i = 0; i < 40; i++) {
    // wait out loading spinner
    const loading = page.locator('.sudoku-loading:visible, label:has-text("Loading")');
    if (await loading.isVisible().catch(() => false)) {
      await sleep(500);
      continue;
    }
    if (await canvas.isVisible().catch(() => false)) {
      // ensure non-zero size
      const box = await canvas.boundingBox().catch(() => null);
      if (box && box.width > 40 && box.height > 40) return canvas;
    }
    await sleep(400);
  }
  return canvas;
}

/**
 * Yoda multi-type:
 *  1) classic SLIDER  → traditional gap+drag (NO AI) — preferred / what users often see
 *  2) connect-dots / tap-icons → AI last resort only
 */
async function trySolveYoda(page, onLog) {
  const body = await page.locator('body').innerText().catch(() => '');
  const yodaVisible = await page
    .locator(
      '#yodaVerify, .yoda-verify-container, .yoda-sudoku-wrap, .sudoku-canvas, .yoda-slider-wrapper, [class*="slider"]'
    )
    .first()
    .isVisible()
    .catch(() => false);
  if (
    !yodaVisible &&
    !/tap icons|connect the dots|shortest line|安全验证|yoda|滑块|拖动|slide/i.test(body)
  ) {
    return { handled: false };
  }

  log(onLog, 'Yoda challenge detected — wait 3s...');
  await sleep(3000);
  const still = await page
    .locator('#yodaVerify, .yoda-sudoku-wrap, canvas.sudoku-canvas, .yoda-slider-wrapper, [class*="slider-btn"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (!still) {
    log(onLog, 'Yoda gone without solver');
    return { handled: true, method: 'wait' };
  }

  // Prefer classic SLIDER (what manual users usually see): refresh until slider, solve without AI
  for (let rotate = 0; rotate < 6; rotate++) {
    const titleNow = await page
      .locator('.sudoku-title, .yoda-modal-content, .yoda-slider-wrapper')
      .first()
      .innerText()
      .catch(() => body);
    const sliderDet = await detectSlider(page);
    const looksSudoku = /connect the dots|shortest line|tap icons|following order|sudoku/i.test(
      titleNow || ''
    );
    const looksSlider =
      (!!sliderDet && !looksSudoku) ||
      /滑块|向右滑动|拖动滑块|slide to|drag the slider|hold the slider/i.test(titleNow || body);

    log(onLog, `Yoda probe#${rotate}: slider=${!!sliderDet} sudoku=${looksSudoku} title=${(titleNow || '').slice(0, 60)}`);

    if (looksSlider || (!!sliderDet && !looksSudoku)) {
      log(onLog, 'Yoda type=SLIDER → traditional gap+drag (NO AI)');
      for (let attempt = 1; attempt <= 4; attempt++) {
        const r = await solveSliderTraditional(page, (m) => log(onLog, m));
        if (r.ok) {
          log(onLog, `slider OK attempt=${attempt} dist=${r.distance}`);
          return { handled: true, method: r.method };
        }
        log(onLog, `slider fail ${attempt}: ${r.error}`);
        try {
          await page.locator('.sudoku-operate-refresh, img[alt="refresh"], [class*="refresh"]').first().click({ timeout: 1500 });
          await sleep(2800);
        } catch {
          /* ignore */
        }
      }
      // keep refreshing for another slider instance
    }

    // Not slider (or slider failed): try refresh to roll a slider type
    try {
      await page.locator('.sudoku-operate-refresh, img[alt="refresh"], [class*="refresh"]').first().click({ timeout: 1500 });
      log(onLog, `refresh Yoda to roll type (${rotate + 1}/6)`);
      await sleep(3500);
    } catch {
      log(onLog, 'no refresh control');
      break;
    }
  }

  // Still non-slider → AI last resort for connect-dots / tap-icons only
  const ca = getCaptchaAiConfig();
  if (!ca.ready) {
    return {
      handled: false,
      error: 'non-slider Yoda remains after refresh; captcha_ai not enabled for sudoku/tap last-resort',
    };
  }

  log(onLog, 'waiting Yoda canvas (slow load)...');
  let canvas = await waitCanvasReady(page);
  let box = await canvas.boundingBox().catch(() => null);
  if (!box || box.width < 40) {
    const area = page.locator('.sudoku-image, .yoda-sudoku-wrap, .yoda-modal-content').first();
    box = await area.boundingBox().catch(() => null);
  }
  if (!box) {
    return { handled: false, error: 'Yoda canvas/area not ready' };
  }

  log(onLog, 'AI captcha fallback for Yoda sudoku/tap (last resort only)...');
  const shotLoc = page.locator('.yoda-modal-content, .yoda-sudoku-wrap, #yodaVerify').first();
  let mapBox = (await shotLoc.boundingBox().catch(() => null)) || box;

  let points = null;
  for (let round = 1; round <= 3; round++) {
    const shot = await shotLoc.screenshot({ type: 'png' }).catch(() => page.screenshot({ type: 'png' }));
    mapBox = (await shotLoc.boundingBox().catch(() => null)) || mapBox || box;
    const ai = await solveYodaSudokuWithAi(shot);
    if (ai.ok && ai.points?.length >= 2) {
      points = ai.points;
      log(onLog, `AI points (round ${round})=${JSON.stringify(points)}`);
      break;
    }
    log(onLog, `AI sudoku parse round ${round}: ${ai.error || ai.raw || 'no points'}`);
    try {
      await page.locator('.sudoku-operate-refresh, img[alt="refresh"]').first().click({ timeout: 2000 });
      await sleep(4000);
      canvas = await waitCanvasReady(page);
    } catch {
      /* ignore */
    }
  }
  if (!points?.length) {
    return { handled: false, error: 'AI could not extract connect-dot points' };
  }

  const sudokuTitle = await page.locator('.sudoku-title').first().innerText().catch(async () => {
    return page.locator('.yoda-modal-content').first().innerText().catch(() => '');
  });
  log(onLog, `Yoda sudoku title: ${(sudokuTitle || '').slice(0, 80)}`);
  const needTap = /tap icons|点选|按顺序点击|following order/i.test(sudokuTitle || '');
  const needDrag = !needTap;
  const xy = points.map(([rx, ry]) => [
    mapBox.x + Math.min(0.98, Math.max(0.02, rx)) * mapBox.width,
    mapBox.y + Math.min(0.98, Math.max(0.02, ry)) * mapBox.height,
  ]);

  if (needDrag && xy.length >= 2) {
    log(onLog, 'Yoda mode=drag-connect (AI last resort)');
    await page.mouse.move(xy[0][0], xy[0][1]);
    await sleep(100);
    await page.mouse.down();
    for (let i = 1; i < xy.length; i++) {
      await page.mouse.move(xy[i][0], xy[i][1], { steps: 18 });
      await sleep(60);
    }
    await sleep(120);
    await page.mouse.up();
  } else {
    log(onLog, 'Yoda mode=tap-sequence (AI last resort)');
    for (const [x, y] of xy) {
      await page.mouse.click(x, y, { delay: 50 });
      await sleep(320);
    }
  }

  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const body2 = await page.locator('body').innerText().catch(() => '');
    if (!/connect the dots|tap icons|shortest line|滑块|slide/i.test(body2)) {
      log(onLog, 'Yoda prompt gone after AI path');
      return { handled: true, method: needDrag ? 'ai_sudoku_drag' : 'ai_sudoku_tap' };
    }
  }
  return { handled: false, error: 'Yoda still visible after AI path' };
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
