/**
 * Full-auto LongCat overseas email registration via Camoufox + Patchright.
 *
 * Critical UI facts (reverse-engineered 2026-07):
 *  - Default view is **phone** login, not email.
 *  - Must click **「Continue with email」** first.
 *  - Email field: input[placeholder*="Email"] / input.oversea-input-container
 *  - Submit is **div.submit-btn** (NOT <button>).
 *  - After submit, Yoda **sudoku/connect-dots** often appears (canvas.sudoku-canvas).
 *  - Bare HTTP → 403; browser loads H5Guard.
 *  - AI captcha is last-resort only for Yoda after wait.
 *
 * Browser: Camoufox (preferred) → Patchright Chromium fallback. No stock Playwright.
 */

import { config } from '../config.js';
import { createAddress, isTempMailConfigured, waitForCode } from './tempMail.js';
import { buildLoginPageUrl, MYKEETA } from './mykeetaClient.js';
import { getCaptchaAiConfig, solveYodaSudokuWithAi } from './captchaAi.js';
import { detectSlider, solveSliderTraditional } from './sliderCaptcha.js';
import { launchBrowser, defaultContextOptions } from './browser.js';
import {
  ensureAuthProxy,
  cookiesToLongcatSession,
  isLongcatUrl,
} from './mykeetaAuthRuntime.js';
import {
  attachYodaImageCapture,
  grabYodaDotsImage,
  grabYodaTapImages,
  solveDotsLocal,
  solveTapLocal,
  colorFromYodaText,
  localSolverHealth,
} from './localCaptcha.js';

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

function attachNetworkWatch(page, state) {
  page.on('response', async (res) => {
    try {
      const u = res.url();
      // API host can be passport.mykeeta.com OR passport-hk.mykeeta.com etc.
      if (!/mykeeta\.com\/api\//i.test(u)) return;
      if (!/emaillogin|emailsignup|userrisk|mobilelogin|yoda|risk/i.test(u)) return;
      const status = res.status();
      let body = '';
      try {
        body = (await res.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      state.apiLogs.push({ u: u.slice(0, 180), status, body: body.slice(0, 280) });
      if (/userriskcheck/i.test(u) && status >= 200 && status < 300) {
        state.riskOk = true;
        state.lastRisk = body;
      }
      if (/emailloginapply|emailsignupapply/i.test(u) && status >= 200 && status < 300) {
        if (/serialNumber|serial_number/i.test(body) || !/"error"\s*:/.test(body)) state.applyOk = true;
      }
      if (status === 403) state.got403 = true;
    } catch {
      /* ignore */
    }
  });
}

/** True email field only — never match phone (oversea-mobile-input / type=tel). */
function emailInputLocator(page) {
  return page
    .locator(
      'input[placeholder*="Email" i]:not([type="tel"]):not(.oversea-mobile-input), input[type="email"], input.oversea-input-container:not(.oversea-mobile-input):not([type="tel"])'
    )
    .first();
}

async function hasEmailInput(page) {
  return emailInputLocator(page).isVisible().catch(() => false);
}

/** Switch from default phone UI to email UI */
export async function switchToEmail(page, onLog) {
  if (await hasEmailInput(page)) {
    log(onLog, 'already on email form');
    return;
  }

  // Prefer DOM event click — Camoufox often hangs on locator.click
  const switched = await page.evaluate(() => {
    const el =
      document.querySelector('span.change-signin-text') ||
      [...document.querySelectorAll('span,div,a,button')].find((n) =>
        /continue with email/i.test((n.textContent || '').trim())
      );
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });
  if (switched) {
    log(onLog, 'clicked Continue with email (dom)');
    await sleep(1800);
    if (await hasEmailInput(page)) return;
  }

  // Playwright force click fallbacks
  for (const loc of [
    page.locator('span.change-signin-text, .change-signin-text'),
    page.getByText(/continue with email/i),
    page.locator('text=Continue with email'),
  ]) {
    try {
      if (await loc.first().isVisible({ timeout: 2000 })) {
        await loc.first().click({ timeout: 5000, force: true }).catch(() => {});
        log(onLog, 'clicked Continue with email (force)');
        await sleep(1500);
        if (await hasEmailInput(page)) return;
      }
    } catch {
      /* next */
    }
  }

  if (await hasEmailInput(page)) {
    log(onLog, 'switched to email form');
    return;
  }
  const phone = page.locator('input[type="tel"], .oversea-mobile-input');
  if (await phone.first().isVisible().catch(() => false)) {
    throw new Error('phone login UI still shown; cannot find Continue with email');
  }
}

export async function fillEmail(page, email, onLog) {
  // DOM-first fill (Camoufox-safe)
  const ok = await page.evaluate((value) => {
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
    if (nativeSet) nativeSet.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, email);

  if (ok) {
    const val = await page.evaluate(() => {
      const el = [...document.querySelectorAll('input')].find(
        (i) =>
          ((i.placeholder || '').toLowerCase().includes('email') || i.type === 'email') &&
          i.type !== 'tel'
      );
      return el?.value || '';
    });
    log(onLog, `filled email via evaluate val=${val}`);
    if (val.includes('@')) return true;
  }

  const loc = emailInputLocator(page);
  try {
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    await loc.fill(email);
    const val = await loc.inputValue().catch(() => '');
    log(onLog, `filled email via locator val=${val}`);
    if (val.includes('@')) return true;
  } catch {
    /* fall through */
  }

  throw new Error('email input not found (did switchToEmail run?)');
}

/** Submit is div.submit-btn, not a real <button> */
export async function clickSubmitContinue(page, onLog) {
  // Prefer evaluate — Camoufox hangs on locator.click
  const ok = await page.evaluate(() => {
    const el =
      document.querySelector('div.submit-btn') ||
      [...document.querySelectorAll('div,button,span')].find(
        (n) => (n.innerText || '').trim() === 'Continue' && (n.children?.length || 0) <= 1
      );
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });
  if (ok) {
    log(onLog, 'submit via evaluate click');
    return true;
  }
  try {
    const btn = page.locator('div.submit-btn').first();
    if (await btn.isVisible({ timeout: 2000 })) {
      await btn.click({ force: true, timeout: 5000 });
      log(onLog, 'submit via div.submit-btn');
      return true;
    }
  } catch (e) {
    log(onLog, `submit strategy fail: ${e.message}`);
  }
  return false;
}

async function waitCanvasReady(page) {
  const canvas = page
    .locator(
      'canvas.sudoku-canvas, canvas.yoda-global-inference-question, .sudoku-image canvas, .yoda-sudoku-wrap canvas, .yoda-modal-content canvas, canvas'
    )
    .first();
  for (let i = 0; i < 40; i++) {
    const loading = page.locator('.sudoku-loading:visible, label:has-text("Loading")');
    if (await loading.isVisible().catch(() => false)) {
      await sleep(500);
      continue;
    }
    if (await canvas.isVisible().catch(() => false)) {
      const box = await canvas.boundingBox().catch(() => null);
      if (box && box.width > 40 && box.height > 40) {
        const painted = await canvas
          .evaluate((element) => {
            try {
              const width = element.width || element.clientWidth;
              const height = element.height || element.clientHeight;
              const ctx = element.getContext?.('2d', { willReadFrequently: true });
              if (!ctx || width < 20 || height < 20) return false;
              const pixels = ctx.getImageData(0, 0, width, height).data;
              let min = 255;
              let max = 0;
              let opaque = 0;
              const stride = Math.max(4, Math.floor((width * height) / 3000) * 4);
              for (let offset = 0; offset < pixels.length; offset += stride) {
                const alpha = pixels[offset + 3];
                if (alpha > 20) opaque++;
                const lum = (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
                min = Math.min(min, lum);
                max = Math.max(max, lum);
              }
              return opaque > 30 && max - min > 18;
            } catch {
              return false;
            }
          })
          .catch(() => false);
        if (painted) return canvas;
      }
    }
    await sleep(400);
  }
  return canvas;
}

function assertPageOpen(page, where = 'page') {
  if (!page || page.isClosed?.()) {
    throw new Error(`${where}: browser page already closed (Camoufox crashed or window closed)`);
  }
}

async function yodaText(page) {
  assertPageOpen(page, 'yodaText');
  const parts = [];
  for (const sel of [
    '.yoda-global-inference-title',
    '.sudoku-title',
    '.yoda-modal-content',
    '.global-puzzle-main',
    '#yodaVerify',
    'body',
  ]) {
    try {
      if (page.isClosed?.()) break;
      const t = await page.locator(sel).first().innerText({ timeout: 1500 }).catch(() => '');
      if (t) parts.push(t);
    } catch (e) {
      if (/closed|Target page/i.test(e.message || '')) {
        throw new Error(`yodaText: page closed while reading (${sel})`);
      }
    }
  }
  return parts.join('\n');
}

function classifyYoda(text) {
  const t = text || '';
  if (/move the slider|slider below|complete the puzzle|向右滑动|拖动滑块|拖动下面/i.test(t)) {
    return 'slider';
  }
  if (/tap icons|following order|点选|按顺序点击|按顺序点/i.test(t)) return 'tap';
  if (/connect the dots|shortest line|连线|最短/i.test(t)) return 'dots';
  return 'unknown';
}

async function classifyYodaPage(page, text = '') {
  const byText = classifyYoda(text);
  if (byText !== 'unknown') return byText;
  if (/network request error|network error|request failed/i.test(text)) return 'network_error';

  const det = await detectSlider(page);
  if (det) return 'slider';

  const visible = async (selector) =>
    page.locator(selector).first().isVisible().catch(() => false);
  if (
    await visible(
      '.yoda-sudoku-wrap, canvas.sudoku-canvas, .sudoku-title, .sudoku-image'
    )
  ) {
    return 'dots';
  }
  if (
    await visible(
      '.yoda-global-inference-wrapper, canvas.yoda-global-inference-question, .yoda-global-inference-panel'
    )
  ) {
    return 'tap';
  }
  return 'unknown';
}

async function waitYodaKind(page, onLog, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  let kind = 'unknown';
  while (Date.now() < deadline) {
    text = await yodaText(page);
    kind = await classifyYodaPage(page, text);
    if (kind !== 'unknown') return { kind, text };
    await sleep(500);
  }
  log(onLog, `Yoda render timeout after ${timeoutMs}ms`);
  return { kind, text };
}

async function clickYodaRefresh(page, onLog) {
  const sels = [
    '.global-puzzle-slider-operate-refresh',
    '.sudoku-operate-refresh',
    '.yoda-global-inference-wrapper img[src*="refresh"]',
    '.yoda-modal-content img[src*="refresh"]',
    '#yodaVerify img[src*="refresh"]',
    'img[alt="refresh"]',
    'img[src*="refresh.png"]',
    '[class*="refresh"]',
  ];
  for (const s of sels) {
    const loc = page.locator(s).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 1500, force: true }).catch(() => {});
      log(onLog, `yoda refresh via ${s}`);
      return true;
    }
  }
  // last resort: any small clickable near modal bottom-right
  const hit = await page.evaluate(() => {
    const root = document.querySelector('#yodaVerify, .yoda-modal-content') || document.body;
    const imgs = [...root.querySelectorAll('img, div, span')];
    for (const el of imgs) {
      const r = el.getBoundingClientRect();
      if (r.width < 14 || r.width > 40 || r.height < 14 || r.height > 40) continue;
      const src = el.getAttribute?.('src') || '';
      const cls = (el.className || '').toString();
      if (/refresh|reload|换/i.test(src + cls) || r.x > window.innerWidth * 0.55) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }
    }
    return false;
  });
  if (hit) log(onLog, 'yoda refresh via evaluate');
  return hit;
}

function yodaStillPresent(text) {
  return /tap icons|following order|connect the dots|shortest line|move the slider|complete the puzzle|滑块|安全验证|点选/i.test(
    text || ''
  );
}

/**
 * Detect colored dots on sudoku canvas (no AI).
 * Title often: "connect the dots in yellow/green/orange/purple".
 * Returns CSS centers relative to canvas box.
 */
async function detectColoredDots(page, onLog) {
  const log = (m) => {
    if (typeof onLog === 'function') onLog(m);
  };
  const text = await yodaText(page);
  const colorHint = (() => {
    if (/yellow/i.test(text)) return 'yellow';
    if (/green/i.test(text)) return 'green';
    if (/orange/i.test(text)) return 'orange';
    if (/purple|violet/i.test(text)) return 'purple';
    if (/blue/i.test(text)) return 'blue';
    if (/red/i.test(text)) return 'red';
    return 'any';
  })();

  const canvas = page
    .locator('canvas.sudoku-canvas, .yoda-sudoku-wrap canvas, .yoda-modal-content canvas, canvas')
    .first();
  if (!(await canvas.isVisible().catch(() => false))) return null;
  const box = await canvas.boundingBox();
  if (!box || box.width < 40) return null;

  const dots = await canvas.evaluate((el, colorHint) => {
    const w = el.width || el.clientWidth;
    const h = el.height || el.clientHeight;
    const ctx = el.getContext('2d', { willReadFrequently: true });
    let data;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch {
      return { error: 'tainted' };
    }

    function match(r, g, b, a) {
      if (a < 80) return false;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      if (colorHint === 'yellow') return r > 160 && g > 140 && b < 120 && r + g > b * 2.2;
      if (colorHint === 'green') return g > 120 && g > r * 1.15 && g > b * 1.15 && sat > 30;
      if (colorHint === 'orange') return r > 160 && g > 70 && g < 180 && b < 100 && r > g;
      if (colorHint === 'purple') return r > 80 && b > 100 && g < r * 0.9 && b > g;
      if (colorHint === 'blue') return b > 120 && b > r * 1.1 && b > g * 1.05;
      if (colorHint === 'red') return r > 150 && r > g * 1.3 && r > b * 1.3;
      // any saturated blob
      return sat > 50 && max > 120;
    }

    // downsample scan
    const step = Math.max(2, Math.floor(Math.min(w, h) / 120));
    const cells = [];
    for (let y = 4; y < h - 4; y += step) {
      for (let x = 4; x < w - 4; x += step) {
        const i = (y * w + x) * 4;
        if (match(data[i], data[i + 1], data[i + 2], data[i + 3])) {
          cells.push([x, y]);
        }
      }
    }
    if (cells.length < 8) return { colorHint, count: cells.length, clusters: [] };

    // simple clustering
    const used = new Array(cells.length).fill(false);
    const clusters = [];
    const rad = Math.max(10, Math.min(w, h) * 0.06);
    for (let i = 0; i < cells.length; i++) {
      if (used[i]) continue;
      const q = [i];
      used[i] = true;
      let sx = 0;
      let sy = 0;
      let n = 0;
      while (q.length) {
        const k = q.pop();
        const [x, y] = cells[k];
        sx += x;
        sy += y;
        n++;
        for (let j = 0; j < cells.length; j++) {
          if (used[j]) continue;
          const dx = cells[j][0] - x;
          const dy = cells[j][1] - y;
          if (dx * dx + dy * dy <= rad * rad) {
            used[j] = true;
            q.push(j);
          }
        }
      }
      if (n >= 3) {
        clusters.push({ x: sx / n, y: sy / n, n });
      }
    }
    // keep larger clusters, sort left-to-right then top-bottom for a stable path seed
    clusters.sort((a, b) => b.n - a.n);
    const top = clusters.slice(0, 8);
    top.sort((a, b) => a.x - b.x || a.y - b.y);
    return {
      colorHint,
      nativeW: w,
      nativeH: h,
      clusters: top.map((c) => ({
        rx: c.x / w,
        ry: c.y / h,
        n: c.n,
      })),
    };
  }, colorHint);

  if (!dots || dots.error || !dots.clusters?.length) {
    log(`dot detect fail color=${colorHint} ${dots?.error || 'none'}`);
    return null;
  }
  log(
    `dot detect color=${dots.colorHint} n=${dots.clusters.length} ` +
      dots.clusters.map((c) => `(${c.rx.toFixed(2)},${c.ry.toFixed(2)})`).join(' ')
  );
  if (dots.clusters.length < 2) return null;

  // order by nearest-neighbor path (shortest-ish polyline)
  const pts = dots.clusters.map((c) => ({ rx: c.rx, ry: c.ry }));
  const ordered = [pts[0]];
  const left = pts.slice(1);
  while (left.length) {
    const last = ordered[ordered.length - 1];
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < left.length; i++) {
      const d = (left[i].rx - last.rx) ** 2 + (left[i].ry - last.ry) ** 2;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    ordered.push(left.splice(bi, 1)[0]);
  }

  return {
    box,
    points: ordered.map((p) => [p.rx, p.ry]),
    colorHint: dots.colorHint,
  };
}

function stage(onLog, msg) {
  // High-visibility progress so headed users know the bot is working
  log(onLog, `[captcha] ${msg}`);
}

async function dragConnectOnCanvas(page, box, pointsRatio, onLog) {
  const xy = pointsRatio.map(([rx, ry]) => [
    box.x + Math.min(0.98, Math.max(0.02, rx)) * box.width,
    box.y + Math.min(0.98, Math.max(0.02, ry)) * box.height,
  ]);
  stage(onLog, `拖线中… ${xy.length} 点`);
  await page.mouse.move(xy[0][0], xy[0][1]);
  await sleep(60);
  await page.mouse.down();
  for (let i = 1; i < xy.length; i++) {
    await page.mouse.move(xy[i][0], xy[i][1], { steps: 10 });
    await sleep(30);
  }
  await page.mouse.up();
  stage(onLog, '拖线完成，等待校验…');
}

async function waitYodaCleared(page, onLog, method) {
  // ~2.5s max — fail fast and refresh instead of staring at the modal
  const maxTicks = Number(process.env.LONGCAT2API_YODA_CLEAR_TICKS || 10);
  for (let i = 0; i < maxTicks; i++) {
    if (page.isClosed?.()) return null;
    await sleep(250);
    if (i === 3 || i === 7) stage(onLog, `校验中… (${method} ${i + 1}/${maxTicks})`);
    let body2 = '';
    try {
      body2 = await yodaText(page);
    } catch {
      return null;
    }
    if (!yodaStillPresent(body2)) {
      const boxStatic = await page.locator('div.box-static').isVisible().catch(() => false);
      const puzzle = await page
        .locator(
          'canvas.sudoku-canvas, .yoda-global-inference-wrapper, canvas.yoda-global-inference-question, .global-puzzle-main'
        )
        .first()
        .isVisible()
        .catch(() => false);
      if (!boxStatic && !puzzle) {
        stage(onLog, `通过 ✓ (${method})`);
        return { handled: true, method };
      }
      if (!puzzle) {
        stage(onLog, `通过 ✓ puzzle gone (${method})`);
        return { handled: true, method };
      }
    }
  }
  stage(onLog, `未通过，准备换题 (${method})`);
  return null;
}

/**
 * Local (no cloud) solvers for dots / tap-icons.
 * Strong progress logs + hard timeouts so headed UI never looks frozen.
 */
async function solveYodaLocalNonSlider(page, onLog, kindHint = 'tap') {
  stage(onLog, '等待画布就绪…');
  const readyCanvas = await waitCanvasReady(page);
  if (!readyCanvas) {
    return { handled: false, error: 'Yoda canvas remained blank or unrendered' };
  }
  if (page.isClosed?.()) {
    return { handled: false, error: 'page closed before local solve' };
  }
  const text = await yodaText(page);
  const detectedKind = await classifyYodaPage(page, text);
  const kind = detectedKind === 'unknown' ? kindHint : detectedKind;
  stage(onLog, `本地求解开始 kind=${kind}`);

  // ─── connect-the-dots (max 1 refresh — frequent refresh triggers risk) ───
  if (kind === 'dots' || kindHint === 'dots') {
    for (let attempt = 1; attempt <= 2; attempt++) {
      assertPageOpen(page, 'local-dots');
      const t0 = Date.now();
      stage(onLog, `连线 attempt ${attempt}/2 — 截图中…`);

      const shot = await grabYodaDotsImage(page);
      const canvasBox = await page
        .locator(
          'canvas.sudoku-canvas, canvas.yoda-global-inference-question, .yoda-modal-content canvas'
        )
        .first()
        .boundingBox()
        .catch(() => null);

      if (shot && canvasBox) {
        const color = colorFromYodaText(text);
        stage(onLog, `连线 attempt ${attempt}/2 — 本地色点识别中 (color=${color}, timeout=8s)…`);
        const local = await solveDotsLocal({ imagePng: shot, color });
        const ms = Date.now() - t0;
        if (local?.ok && local.points?.length >= 2 && local.points.length <= 10) {
          stage(
            onLog,
            `连线识别成功 ${ms}ms pts=${local.points.length} ${JSON.stringify(local.points).slice(0, 80)}`
          );
          await dragConnectOnCanvas(page, canvasBox, local.points, onLog);
          const cleared = await waitYodaCleared(page, onLog, 'local_dots');
          if (cleared) return cleared;
        } else {
          stage(onLog, `连线识别失败 ${ms}ms: ${local?.error || `pts=${local?.points?.length || 0}`}`);
        }
      } else {
        stage(onLog, `连线截图失败 shot=${!!shot} box=${!!canvasBox}`);
      }

      // in-page colored blob detector (no refresh)
      stage(onLog, `连线 attempt ${attempt}/2 — 页内色点兜底…`);
      const det = await detectColoredDots(page, onLog);
      if (det?.points?.length >= 2 && det.points.length <= 10) {
        stage(onLog, `页内色点 pts=${det.points.length}`);
        await dragConnectOnCanvas(page, det.box, det.points, onLog);
        const cleared = await waitYodaCleared(page, onLog, 'traditional_dots');
        if (cleared) return cleared;
      }

      if (attempt < 2) {
        stage(onLog, `连线 attempt ${attempt}/2 失败 — 仅换题 1 次…`);
        await clickYodaRefresh(page, onLog);
        await sleep(900);
      }
    }
  }

  // ─── tap icons (max 1 refresh) ───
  if (kind === 'tap' || kindHint === 'tap') {
    for (let attempt = 1; attempt <= 2; attempt++) {
      assertPageOpen(page, 'local-tap');
      const t0 = Date.now();
      stage(onLog, `点选 attempt ${attempt}/2 — 截取目标条+面板…`);

      const imgs = await grabYodaTapImages(page);
      const panelLoc = page
        .locator(
          'canvas.yoda-global-inference-question, .yoda-global-inference-panel, .yoda-global-inference-wrapper canvas'
        )
        .first();
      const panelBox = await panelLoc.boundingBox().catch(() => null);

      if (imgs?.targetsPng && imgs?.panelPng && panelBox) {
        stage(onLog, `点选 attempt ${attempt}/2 — 本地模板匹配中 (timeout=10s)…`);
        const local = await solveTapLocal({
          targetsPng: imgs.targetsPng,
          panelPng: imgs.panelPng,
        });
        const ms = Date.now() - t0;
        if (local?.ok && local.points?.length >= 2) {
          stage(
            onLog,
            `点选识别成功 ${ms}ms n=${local.points.length} conf=${Number(local.confidence || 0).toFixed(2)}`
          );
          stage(onLog, `点击序列中… ${local.points.length} 次`);
          for (const [rx, ry] of local.points) {
            const x = panelBox.x + Math.min(0.98, Math.max(0.02, rx)) * panelBox.width;
            const y = panelBox.y + Math.min(0.98, Math.max(0.02, ry)) * panelBox.height;
            await page.mouse.click(x, y, { delay: 35 });
            await sleep(220);
          }
          stage(onLog, '点击完成，等待校验…');
          const cleared = await waitYodaCleared(page, onLog, 'local_tap');
          if (cleared) return cleared;
        } else {
          stage(onLog, `点选识别失败 ${ms}ms: ${local?.error || 'no points'}`);
        }
      } else {
        stage(
          onLog,
          `点选截图不完整 targets=${!!imgs?.targetsPng} panel=${!!imgs?.panelPng} box=${!!panelBox}`
        );
      }

      if (attempt < 2) {
        stage(onLog, `点选 attempt ${attempt}/2 失败 — 仅换题 1 次…`);
        await clickYodaRefresh(page, onLog);
        await sleep(900);
      }
    }
  }

  return { handled: false, error: `local solver exhausted kind=${kind}` };
}

/**
 * Cloud AI path for tap-icons / connect-dots (last resort after local).
 */
async function solveYodaWithAi(page, onLog, kindHint = 'tap') {
  // Local first — ddddocr/opencv/template (GitHub mature stack)
  const local = await solveYodaLocalNonSlider(page, onLog, kindHint);
  if (local?.handled) return local;
  if (/blank|unrendered|network request error/i.test(local?.error || '')) return local;

  const ca = getCaptchaAiConfig();
  if (!ca.ready) {
    return {
      handled: false,
      error:
        local?.error ||
        'local captcha failed; captcha_ai not ready (set model e.g. grok-4.5)',
    };
  }

  stage(onLog, `本地未过 → AI 兜底 kind=${kindHint} model=${ca.model}…`);
  await waitCanvasReady(page);

  // Screenshot ONLY the puzzle area (title+canvas), not full mask
  const shotLoc = page
    .locator(
      'canvas.sudoku-canvas, canvas.yoda-global-inference-question, .yoda-sudoku-wrap, .yoda-global-inference-wrapper, .yoda-modal-content'
    )
    .first();

  let points = null;
  let mapBox = null;
  for (let round = 1; round <= 3; round++) {
    mapBox = await shotLoc.boundingBox().catch(() => null);
    if (!mapBox) {
      mapBox = await page.locator('.yoda-modal-content').first().boundingBox().catch(() => null);
    }
    // Prefer page.clip — element.screenshot hangs 45s on Camoufox captcha layers
    let shot = null;
    if (mapBox && mapBox.width > 8 && mapBox.height > 8) {
      shot = await page
        .screenshot({
          type: 'png',
          clip: {
            x: Math.max(0, Math.floor(mapBox.x)),
            y: Math.max(0, Math.floor(mapBox.y)),
            width: Math.min(Math.ceil(mapBox.width), 1200),
            height: Math.min(Math.ceil(mapBox.height), 900),
          },
          timeout: 3000,
        })
        .catch(() => null);
    }
    if (!shot) {
      shot = await shotLoc.screenshot({ type: 'png', timeout: 2000 }).catch(() => null);
    }
    if (!shot) {
      log(onLog, `AI shot empty round${round}`);
      await clickYodaRefresh(page);
      await sleep(600);
      continue;
    }
    const ai = await solveYodaSudokuWithAi(shot);
    if (ai.ok && ai.points?.length >= 2) {
      const xs = ai.points.map((p) => p[0]);
      const ys = ai.points.map((p) => p[1]);
      const spread =
        Math.max(...xs) - Math.min(...xs) + (Math.max(...ys) - Math.min(...ys));
      if (spread < 0.12) {
        log(onLog, `AI points too clustered spread=${spread.toFixed(3)} — retry`);
      } else {
        points = ai.points;
        log(onLog, `AI points round${round}=${JSON.stringify(points)}`);
        break;
      }
    } else {
      log(onLog, `AI parse round${round}: ${ai.error || ai.raw || 'no points'}`);
    }
    await clickYodaRefresh(page, onLog);
    await sleep(1000);
  }
  if (!points?.length || !mapBox) {
    return {
      handled: false,
      error: local?.error || 'AI could not extract points',
    };
  }

  const text = await yodaText(page);
  const kind = classifyYoda(text) || kindHint;
  const xy = points.map(([rx, ry]) => [
    mapBox.x + Math.min(0.98, Math.max(0.02, rx)) * mapBox.width,
    mapBox.y + Math.min(0.98, Math.max(0.02, ry)) * mapBox.height,
  ]);

  if (kind === 'dots' || (kind === 'unknown' && kindHint === 'dots')) {
    log(onLog, 'Yoda AI mode=drag-connect');
    await page.mouse.move(xy[0][0], xy[0][1]);
    await sleep(60);
    await page.mouse.down();
    for (let i = 1; i < xy.length; i++) {
      await page.mouse.move(xy[i][0], xy[i][1], { steps: 10 });
      await sleep(30);
    }
    await page.mouse.up();
  } else {
    log(onLog, 'Yoda AI mode=tap-sequence');
    for (const [x, y] of xy) {
      await page.mouse.click(x, y, { delay: 40 });
      await sleep(280);
    }
  }

  const cleared = await waitYodaCleared(page, onLog, `ai_${kind}`);
  if (cleared) return cleared;
  return { handled: false, error: 'Yoda still visible after local+AI path' };
}

/**
 * Yoda multi-type:
 *  1) classic SLIDER  → traditional gap+drag (NO AI)
 *  2) tap-icons / connect-dots → refresh to roll slider; AI last resort
 *
 * Live dump 2026-07: risk 101258 often yields type=235 "Tap icons in following order"
 * with .yoda-global-inference-* (NOT .box-static slider).
 */
async function trySolveYoda(page, onLog) {
  assertPageOpen(page, 'trySolveYoda');
  let body0 = '';
  try {
    body0 = await yodaText(page);
  } catch (e) {
    return { handled: false, error: e.message };
  }
  const yodaVisible = await page
    .locator(
      '#yodaVerify, .yoda-verify-container, .yoda-global-inference-wrapper, .yoda-sudoku-wrap, .global-puzzle-main, div.box-static, canvas.yoda-global-inference-question'
    )
    .first()
    .isVisible()
    .catch(() => false);
  if (
    !yodaVisible &&
    !/tap icons|connect the dots|shortest line|move the slider|安全验证|yoda|滑块|拖动|slide|following order/i.test(
      body0
    )
  ) {
    return { handled: false };
  }

  stage(onLog, 'Yoda 已出现 — 请勿关闭窗口，自动打码中…');
  await sleep(500);
  if (page.isClosed?.()) {
    return { handled: false, error: 'browser closed right after Yoda appeared' };
  }

  // debug screenshot (best-effort)
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync('data/debug', { recursive: true });
    stage(onLog, '保存出现截图 data/debug/yoda-appear.png…');
    await page.screenshot({ path: 'data/debug/yoda-appear.png' }).catch(() => {});
  } catch {
    /* ignore */
  }

  // First look: if already slider, solve immediately
  {
    stage(onLog, '识别题型中…');
    const ready0 = await waitYodaKind(page, onLog);
    const title0 = ready0.text;
    const kind0 = ready0.kind;
    const det0 = await detectSlider(page);
    stage(
      onLog,
      `题型=${kind0} sliderDet=${!!det0} title=${title0.replace(/\s+/g, ' ').slice(0, 80)}`
    );

    if (kind0 === 'slider' || det0) {
      stage(onLog, '滑块 — 本地 ddddocr/opencv 估距+拖拽…');
      const r = await solveSliderTraditional(page, (m) => log(onLog, m));
      if (r.ok) {
        stage(onLog, `滑块通过 ✓ dist=${r.distance}`);
        return { handled: true, method: r.method };
      }
      stage(onLog, `滑块未过: ${r.error || 'fail'}，继续…`);
    }

    // dots / tap: local solvers first, AI last
    if (kind0 === 'dots' || kind0 === 'tap') {
      return solveYodaWithAi(page, onLog, kind0);
    }
    if (kind0 === 'network_error') {
      return { handled: false, error: 'Yoda network request error' };
    }
  }

  // Unknown / still loading: wait, re-classify — at most ONE refresh (frequent refresh → risk)
  for (let rotate = 0; rotate < 2; rotate++) {
    await sleep(rotate === 0 ? 800 : 400);
    const ready = await waitYodaKind(page, onLog, rotate === 0 ? 10000 : 15000);
    const titleNow = ready.text;
    const kind = ready.kind;
    const sliderDet = await detectSlider(page);
    log(
      onLog,
      `Yoda probe#${rotate}: kind=${kind} det=${!!sliderDet} title=${(titleNow || '').replace(/\s+/g, ' ').slice(0, 80)}`
    );

    if (kind === 'slider' || sliderDet) {
      const r = await solveSliderTraditional(page, (m) => log(onLog, m));
      if (r.ok) return { handled: true, method: r.method };
      // slider solver already limited its own refresh; do not outer-refresh
      break;
    }
    if (kind === 'dots' || kind === 'tap') {
      return solveYodaWithAi(page, onLog, kind);
    }
    if (kind === 'network_error') {
      return { handled: false, error: 'Yoda network request error' };
    }
    // only one outer refresh if still unknown/loading
    if (rotate === 0) {
      await clickYodaRefresh(page, onLog);
      await sleep(900);
    }
  }

  const finalText = await yodaText(page);
  const finalKind = await classifyYodaPage(page, finalText);
  const sliderDet2 = await detectSlider(page);
  if (finalKind === 'slider' || sliderDet2) {
    const r = await solveSliderTraditional(page, (m) => log(onLog, m));
    if (r.ok) return { handled: true, method: r.method };
  }
  if (finalKind === 'dots' || finalKind === 'tap') {
    return solveYodaWithAi(page, onLog, finalKind);
  }
  return { handled: false, error: `unsupported or unrendered Yoda kind=${finalKind}` };
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

/** Public: solve whatever Yoda challenge is on page (slider preferred, AI fallback). */
export async function solveYodaChallenge(page, onLog) {
  try {
    return await trySolveYoda(page, onLog);
  } catch (e) {
    const msg = e?.message || String(e);
    if (/closed|Target page|browser has been closed/i.test(msg)) {
      log(onLog, `Yoda aborted: ${msg}`);
      return { handled: false, error: msg };
    }
    throw e;
  }
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

  const proxyUrl = await ensureAuthProxy({ onLog });
  const loginUrl = buildLoginPageUrl();
  log(onLog, `open ${loginUrl}`);

  let launched;
  try {
    launched = await launchBrowser({
      headless: process.env.LONGCAT2API_REGISTER_HEADLESS !== '0',
      proxyUrl,
    });
  } catch (e) {
    throw new Error(`Browser launch failed: ${e.message}`);
  }
  const { browser, engine, close: closeBrowser } = launched;
  log(onLog, `browser engine=${engine} headless=${launched.headless}`);

  // Lightweight captcha backend check ONLY (import-level). Never load YOLO here —
  // that used to OOM Camoufox when health ran mid-register.
  try {
    const health = await Promise.race([
      localSolverHealth(),
      new Promise((r) => setTimeout(() => r({ ok: false, error: 'health timeout' }), 8000)),
    ]);
    const b = health?.backends || {};
    log(
      onLog,
      `local captcha: ddddocr=${!!b.ddddocr?.ok} recognizer=${!!b.captcha_recognizer?.ok} opencv=${!!b.opencv?.ok}`
    );
  } catch (e) {
    log(onLog, `local captcha health skip: ${e.message}`);
  }

  browser.on?.('disconnected', () => log(onLog, 'browser disconnected'));

  const context = await browser.newContext(defaultContextOptions({ engine }));
  // Patchright only — Camoufox already spoofs webdriver; init scripts can leak
  if (engine === 'patchright') {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {
        /* ignore */
      }
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(SLOW.actionMs);
  page.setDefaultNavigationTimeout(SLOW.gotoMs);
  // Capture captcha image bytes from network for ddddocr
  attachYodaImageCapture(page);

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

    // Submit email — wait for risk API / yoda / otp
    for (let attempt = 1; attempt <= 4; attempt++) {
      log(onLog, `submit continue attempt ${attempt}/4...`);
      await clickSubmitContinue(page, onLog);

      // wait up to 15s for yoda or risk API or otp
      for (let w = 0; w < 15; w++) {
        await sleep(1000);
        if (net.riskOk || net.applyOk) {
          log(onLog, `risk/apply seen after ${w + 1}s`);
          break;
        }
        const yodaNow = await page
          .locator('#yodaVerify, .box-static, .yoda-sudoku-wrap, text=/move the slider|connect the dots|tap icons/i')
          .first()
          .isVisible()
          .catch(() => false);
        if (yodaNow) {
          log(onLog, `yoda UI after ${w + 1}s`);
          break;
        }
        const otpEarly = await page
          .locator('text=/verification code|enter verification/i')
          .first()
          .isVisible()
          .catch(() => false);
        if (otpEarly) break;
      }

      if (net.lastRisk) log(onLog, `risk body: ${String(net.lastRisk).slice(0, 160)}`);

      const y = await trySolveYoda(page, onLog);
      if (y.error) log(onLog, `yoda: ${y.error}`);
      if (y.handled) {
        await sleep(2500);
        // after captcha, continue may need another submit
        const otpVisible = await page
          .locator('text=/verification code|enter verification/i, input[inputmode="numeric"]')
          .first()
          .isVisible()
          .catch(() => false);
        if (!otpVisible) {
          await clickSubmitContinue(page, onLog);
          await sleep(SLOW.afterClickMs);
        }
      }

      if (net.riskOk || net.applyOk) break;
      const otp = await page
        .locator(
          'input[inputmode="numeric"], .verify-code-input input, input[maxlength="6"], .pc-login-verify-code-container, text=/verification code/i'
        )
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
      .waitForURL((url) => isLongcatUrl(url.toString()), {
        timeout: Math.min(SLOW.redirectMs, Math.max(20000, deadline - Date.now())),
      })
      .catch(async () => sleep(8000));

    if (!isLongcatUrl(page.url())) {
      log(onLog, `goto longcat home from ${page.url()}`);
      await page.goto('https://longcat.chat/', { waitUntil: 'domcontentloaded', timeout: SLOW.gotoMs });
    }
    await sleep(4000);

    let parsed = cookiesToLongcatSession(await context.cookies());
    if (!parsed.passport_token) {
      await page.goto('https://longcat.chat/t', { waitUntil: 'domcontentloaded', timeout: SLOW.gotoMs });
      await sleep(5000);
      parsed = cookiesToLongcatSession(await context.cookies());
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
      detail: `registered; engine=${engine}; url=${page.url()}`,
      mykeeta: MYKEETA.origin,
      engine,
    };
  } finally {
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    try {
      await closeBrowser();
    } catch {
      /* ignore */
    }
  }
}
