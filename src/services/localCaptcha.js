/**
 * Local captcha solvers via Python (ddddocr / OpenCV / captcha-recognizer).
 * No cloud AI. Used for Yoda slider / connect-dots / tap-icons.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SOLVER = path.join(ROOT, 'scripts', 'local_captcha_solver.py');

function pythonBin() {
  return (
    process.env.LONGCAT2API_PYTHON ||
    process.env.PYTHON ||
    (process.platform === 'win32' ? 'python' : 'python3')
  );
}

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>}
 */
function envTimeout(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
}

/** Hard defaults: fail fast so UI never looks frozen. */
export const LOCAL_SOLVER_TIMEOUT = {
  health: envTimeout('LONGCAT2API_CAPTCHA_HEALTH_MS', 12000),
  slider: envTimeout('LONGCAT2API_CAPTCHA_SLIDER_MS', 12000),
  dots: envTimeout('LONGCAT2API_CAPTCHA_DOTS_MS', 8000),
  tap: envTimeout('LONGCAT2API_CAPTCHA_TAP_MS', 10000),
};

function tmpDir() {
  const d = path.join(ROOT, 'data', 'debug', 'solver-tmp');
  mkdirSync(d, { recursive: true });
  return d;
}

/** Write buffer to temp png; return path. Avoids Windows spawn ENAMETOOLONG on --*-b64. */
function writeTempPng(buf, tag) {
  const p = path.join(tmpDir(), `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  writeFileSync(p, buf);
  return p;
}

function rmQuiet(p) {
  try {
    if (p && existsSync(p)) unlinkSync(p);
  } catch {
    /* ignore */
  }
}

export function runLocalSolver(args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 12000;
  if (!existsSync(SOLVER)) {
    return Promise.resolve({ ok: false, error: `solver missing: ${SOLVER}` });
  }
  return new Promise((resolve) => {
    const bin = pythonBin();
    const child = spawn(bin, [SOLVER, ...args], {
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      // Windows: also try taskkill on hung python
      try {
        if (child.pid && process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        }
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `solver timeout ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      finish({ ok: false, error: e.message, stderr });
    });
    child.on('close', () => {
      const text = stdout.trim();
      if (!text) {
        finish({ ok: false, error: 'empty solver output', stderr: stderr.slice(0, 300) });
        return;
      }
      // last JSON line
      const lines = text.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      try {
        finish(JSON.parse(last));
      } catch {
        finish({
          ok: false,
          error: 'invalid JSON from solver',
          raw: last.slice(0, 200),
          stderr: stderr.slice(0, 200),
        });
      }
    });
  });
}

export async function localSolverHealth() {
  // import-only health — keep short so registration is not blocked / OOMed
  return runLocalSolver(['health'], { timeoutMs: LOCAL_SOLVER_TIMEOUT.health });
}

/**
 * @param {{ bgPng: Buffer, piecePng?: Buffer|null }} imgs
 */
export async function solveSliderLocal(imgs) {
  // FILE paths only — base64 CLI args hit Windows ENAMETOOLONG
  const bgPath = writeTempPng(imgs.bgPng, 'slider-bg');
  const piecePath = imgs.piecePng?.length ? writeTempPng(imgs.piecePng, 'slider-pc') : null;
  try {
    const args = ['slider', '--bg', bgPath];
    if (piecePath) args.push('--piece', piecePath);
    return await runLocalSolver(args, { timeoutMs: LOCAL_SOLVER_TIMEOUT.slider });
  } finally {
    rmQuiet(bgPath);
    rmQuiet(piecePath);
  }
}

/**
 * @param {{ imagePng: Buffer, color?: string }} opts
 */
export async function solveDotsLocal(opts) {
  const imgPath = writeTempPng(opts.imagePng, 'dots');
  try {
    return await runLocalSolver(
      ['dots', '--image', imgPath, '--color', opts.color || 'any'],
      { timeoutMs: LOCAL_SOLVER_TIMEOUT.dots }
    );
  } finally {
    rmQuiet(imgPath);
  }
}

/**
 * @param {{ targetsPng: Buffer, panelPng: Buffer, nTargets?: number }} opts
 */
export async function solveTapLocal(opts) {
  const tPath = writeTempPng(opts.targetsPng, 'tap-t');
  const pPath = writeTempPng(opts.panelPng, 'tap-p');
  try {
    const args = ['tap', '--targets', tPath, '--panel', pPath];
    if (opts.nTargets) args.push('--n-targets', String(opts.nTargets));
    return await runLocalSolver(args, { timeoutMs: LOCAL_SOLVER_TIMEOUT.tap });
  } finally {
    rmQuiet(tPath);
    rmQuiet(pPath);
  }
}

/**
 * Grab Yoda slider bg/piece images.
 * CRITICAL: hide the floating piece before bg screenshot, otherwise gap CV
 * confuses the left overlay / right border for the hole (user: drag way off).
 *
 * Prefer clean DOM screenshot (CSS-aligned) over network bag when possible.
 * Network images are fallback (may be higher-res; scale via natural_width).
 */
export async function grabYodaSliderImages(page) {
  const pieceLoc = page.locator('.global-puzzle-slider-drag').first();
  let piecePng = null;
  if (await pieceLoc.isVisible().catch(() => false)) {
    piecePng = await pieceLoc.screenshot({ type: 'png', timeout: 2500 }).catch(() => null);
  }

  // Hide piece + handle so bg is clean hole-only (DOM-aligned CSS scale)
  await page
    .evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.global-puzzle-slider-drag, .moveing-bar, div.box-static'
        ),
      ];
      for (const el of nodes) {
        el.dataset._lcVis = el.style.visibility || '';
        el.style.visibility = 'hidden';
      }
    })
    .catch(() => {});

  let bgPng = null;
  let source = 'clean-bg';
  try {
    const bgLoc = page.locator('.global-puzzle-slider-image, .global-puzzle-main').first();
    if (await bgLoc.isVisible().catch(() => false)) {
      bgPng = await bgLoc.screenshot({ type: 'png', timeout: 2500 }).catch(() => null);
    }
    // clip fallback via page.screenshot if element screenshot hangs/fails
    if (!bgPng) {
      const box = await bgLoc.boundingBox().catch(() => null);
      if (box && box.width > 40) {
        bgPng = await page
          .screenshot({
            type: 'png',
            clip: {
              x: Math.max(0, box.x),
              y: Math.max(0, box.y),
              width: Math.min(box.width, 800),
              height: Math.min(box.height, 600),
            },
            timeout: 3000,
          })
          .catch(() => null);
        if (bgPng) source = 'clean-clip';
      }
    }
  } finally {
    await page
      .evaluate(() => {
        const nodes = [
          ...document.querySelectorAll(
            '.global-puzzle-slider-drag, .moveing-bar, div.box-static'
          ),
        ];
        for (const el of nodes) {
          if (el.dataset._lcVis != null) {
            el.style.visibility = el.dataset._lcVis;
            delete el.dataset._lcVis;
          }
        }
      })
      .catch(() => {});
  }

  // Network fallback (raw captcha assets)
  if (!bgPng && page.__yodaImageBag?.bg) {
    bgPng = page.__yodaImageBag.bg;
    source = 'network-bg';
  }
  if (!piecePng && page.__yodaImageBag?.piece) {
    piecePng = page.__yodaImageBag.piece;
  }

  if (!bgPng) return null;
  return {
    bgPng,
    piecePng,
    source: piecePng ? `${source}+piece` : source,
  };
}

/**
 * Attach response listener to capture captcha image bytes.
 */
export function attachYodaImageCapture(page) {
  if (page.__yodaImageBag) return page.__yodaImageBag;
  const bag = { bg: null, piece: null, raw: [] };
  page.__yodaImageBag = bag;
  page.on('response', async (res) => {
    try {
      const u = res.url();
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!/image|octet-stream|png|jpeg|webp/i.test(ct + u)) return;
      if (!/yoda|captcha|puzzle|slider|verify|meituan|mykeeta|s3plus|secfe/i.test(u)) return;
      const buf = Buffer.from(await res.body());
      if (buf.length < 500) return;
      bag.raw.push({ u: u.slice(0, 120), n: buf.length });
      if (/piece|block|slider|shadow|jigsaw/i.test(u)) bag.piece = buf;
      else if (/back|bg|puzzle|image|info/i.test(u) || !bag.bg) bag.bg = buf;
    } catch {
      /* ignore */
    }
  });
  return bag;
}

/**
 * Safe screenshot: prefer page.clip (avoids Camoufox element-screenshot hang
 * on unstable fonts / animating captcha layers — was 45s timeout kills).
 */
async function safeShot(page, loc, timeoutMs = 2500) {
  if (!loc) return null;
  try {
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) return null;
    const box = await loc.boundingBox().catch(() => null);
    if (box && box.width > 8 && box.height > 8) {
      const clip = {
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y)),
        width: Math.max(1, Math.min(Math.ceil(box.width), 1200)),
        height: Math.max(1, Math.min(Math.ceil(box.height), 900)),
      };
      const png = await page
        .screenshot({ type: 'png', clip, timeout: timeoutMs })
        .catch(() => null);
      if (png?.length) return png;
    }
    // last resort: short element shot
    return await loc.screenshot({ type: 'png', timeout: Math.min(1500, timeoutMs) }).catch(() => null);
  } catch {
    return null;
  }
}

/**
 * Grab tap-icons: top answer strip + bottom question panel.
 */
export async function grabYodaTapImages(page) {
  const answer = page
    .locator(
      '.yoda-global-inference-answer, .yoda-global-inference-control, .yoda-global-inference-title + div'
    )
    .first();
  const panel = page
    .locator(
      'canvas.yoda-global-inference-question, .yoda-global-inference-panel, .yoda-global-inference-wrapper canvas'
    )
    .first();

  let targetsPng = await safeShot(page, answer, 2500);
  let panelPng = await safeShot(page, panel, 2500);

  // fallback: whole inference wrapper
  if (!targetsPng || !panelPng) {
    const wrap = page.locator('.yoda-global-inference-wrapper, .yoda-modal-content').first();
    const full = await safeShot(page, wrap, 3000);
    if (full) {
      if (!targetsPng) targetsPng = full;
      if (!panelPng) panelPng = full;
    }
  }

  if (!targetsPng || !panelPng) return null;
  return { targetsPng, panelPng };
}

/**
 * Grab dots canvas image (clip-based; no 45s element hang).
 */
export async function grabYodaDotsImage(page) {
  const loc = page
    .locator(
      'canvas.sudoku-canvas, canvas.yoda-global-inference-question, .yoda-sudoku-wrap canvas, .yoda-modal-content canvas'
    )
    .first();
  return safeShot(page, loc, 3000);
}

export function colorFromYodaText(text) {
  const t = text || '';
  if (/yellow/i.test(t)) return 'yellow';
  if (/green/i.test(t)) return 'green';
  if (/orange/i.test(t)) return 'orange';
  if (/purple|violet/i.test(t)) return 'purple';
  if (/blue/i.test(t)) return 'blue';
  if (/red/i.test(t)) return 'red';
  return 'any';
}
