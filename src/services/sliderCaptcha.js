/**
 * Traditional slider captcha solver (NO AI).
 * - Detect Yoda / generic slide-verify UI
 * - Estimate gap via canvas pixel edges or bg image
 * - Human-like drag trajectory
 */

export function findGapOffset(rgba, width, height, opts = {}) {
  const blockW = Math.max(30, Math.min(80, opts.blockWidth || Math.floor(width * 0.18)));
  const startX = Math.floor(width * 0.18);
  const endX = width - blockW - 2;
  let bestX = startX;
  let bestScore = -1;

  for (let x = startX; x < endX; x++) {
    let edge = 0;
    const y0 = Math.floor(height * 0.2);
    const y1 = Math.floor(height * 0.8);
    for (let y = y0; y < y1; y++) {
      const i = (y * width + x) * 4;
      const j = i + 4;
      edge +=
        Math.abs(rgba[i] - rgba[j]) +
        Math.abs(rgba[i + 1] - rgba[j + 1]) +
        Math.abs(rgba[i + 2] - rgba[j + 2]);
    }
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * width + x) * 4;
      const g = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
      sum += g;
      sum2 += g * g;
      n++;
    }
    const mean = sum / n;
    const variance = sum2 / n - mean * mean;
    const score = edge + variance * 3;
    if (score > bestScore) {
      bestScore = score;
      bestX = x;
    }
  }
  return Math.max(10, Math.min(width - blockW - 5, bestX - Math.floor(blockW * 0.12)));
}

/** Human-like trajectory 0 → distance */
export function buildDragTrack(distance) {
  const dist = Math.max(20, Math.floor(distance));
  const points = [];
  const steps = 32 + Math.floor(Math.random() * 12);
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    // ease-out cubic + slight accel mid
    const ease = 1 - Math.pow(1 - p, 3);
    const x = dist * ease;
    const y = Math.sin(p * Math.PI) * (Math.random() * 2.5 - 0.5);
    points.push({ x, y, t: 6 + Math.random() * 14 });
  }
  points.push({ x: dist + 3 + Math.random() * 5, y: 0, t: 35 });
  points.push({ x: dist - 1 - Math.random() * 2, y: 0, t: 45 });
  points.push({ x: dist, y: 0, t: 55 });
  return points;
}

async function estimateDistance(page, onLog) {
  const log = onLog || (() => {});

  // 1) canvas pixel scan
  try {
    const gap = await page.evaluate(() => {
      const canvases = [...document.querySelectorAll('#yodaVerify canvas, .yoda-modal-content canvas, canvas')];
      // pick largest canvas
      let best = null;
      for (const c of canvases) {
        const w = c.width || c.clientWidth;
        const h = c.height || c.clientHeight;
        if (w > 80 && h > 40 && (!best || w * h > best.w * best.h)) best = { c, w, h };
      }
      if (!best) return null;
      const ctx = best.c.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, best.w, best.h);
      const rgba = img.data;
      const width = best.w;
      const height = best.h;
      const startX = Math.floor(width * 0.18);
      let bestX = startX;
      let bestScore = -1;
      for (let x = startX; x < width - 40; x++) {
        let edge = 0;
        const y0 = Math.floor(height * 0.2);
        const y1 = Math.floor(height * 0.8);
        for (let y = y0; y < y1; y++) {
          const i = (y * width + x) * 4;
          edge +=
            Math.abs(rgba[i] - rgba[i + 4]) +
            Math.abs(rgba[i + 1] - rgba[i + 5]) +
            Math.abs(rgba[i + 2] - rgba[i + 6]);
        }
        if (edge > bestScore) {
          bestScore = edge;
          bestX = x;
        }
      }
      const rect = best.c.getBoundingClientRect();
      return { offset: bestX, width, height, cssW: rect.width, cssH: rect.height };
    });
    if (gap && gap.offset > 0) {
      const scale = gap.cssW / gap.width;
      const dist = Math.floor(gap.offset * scale - 10);
      log(`gap canvas: px=${gap.offset} scale=${scale.toFixed(2)} dist=${dist}`);
      return Math.max(25, dist);
    }
  } catch (e) {
    log(`canvas estimate fail: ${e.message}`);
  }

  // 2) track width ratios (common for pure slide without puzzle)
  try {
    const track = page
      .locator(
        '.yoda-slider-wrapper, [class*="slider-move"], .slide-verify, [class*="slide-verify"], .yoda-modal-content'
      )
      .first();
    const tb = await track.boundingBox();
    if (tb && tb.width > 100) {
      // try three common ratios; caller may retry
      const ratio = 0.62 + Math.random() * 0.12;
      const dist = Math.floor(tb.width * ratio - 40);
      log(`gap track-ratio: w=${tb.width} ratio=${ratio.toFixed(2)} dist=${dist}`);
      return Math.max(30, dist);
    }
  } catch (e) {
    log(`track estimate fail: ${e.message}`);
  }

  return 160 + Math.floor(Math.random() * 40);
}

async function dragBy(page, start, distance, onLog) {
  const log = onLog || (() => {});
  const track = buildDragTrack(distance);
  log(`drag ${Math.round(distance)}px from (${Math.round(start.x)},${Math.round(start.y)})`);
  await page.mouse.move(start.x, start.y);
  await page.waitForTimeout(80 + Math.random() * 80);
  await page.mouse.down();
  for (const p of track) {
    await page.mouse.move(start.x + p.x, start.y + p.y, { steps: 2 });
    await page.waitForTimeout(p.t);
  }
  await page.waitForTimeout(50 + Math.random() * 80);
  await page.mouse.up();
  await page.waitForTimeout(1200 + Math.random() * 600);
}

export async function detectSlider(page) {
  return detectSliderImpl(page);
}

async function detectSliderImpl(page) {
  // Prefer structural handles
  const handleSels = [
    '.slider-move-btn',
    '.yoda-slider-btn',
    '.slide-verify-slider-mask-item',
    '.handler',
    '.slider-btn',
    '[class*="slider-btn"]',
    '[class*="slide-btn"]',
  ];
  for (const sel of handleSels) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      return { kind: 'slider', handle: loc, selector: sel };
    }
  }

  const body = await page.locator('body').innerText().catch(() => '');
  // If sudoku/connect text present, not pure slider
  if (/connect the dots|shortest line|tap icons|following order/i.test(body)) {
    return null;
  }

  // Heuristic small knob in yoda modal
  const pos = await page.evaluate(() => {
    const root =
      document.querySelector('#yodaVerify .yoda-modal-content, .yoda-verify-container, #yodaVerify') ||
      document.body;
    let best = null;
    for (const el of root.querySelectorAll('div, span, button, i')) {
      const r = el.getBoundingClientRect();
      if (r.width < 22 || r.width > 64 || r.height < 22 || r.height > 64) continue;
      const cls = (el.className || '').toString().toLowerCase();
      const score =
        (/slider|slide|handler|move|drag|btn|block|knob/.test(cls) ? 10 : 0) +
        (r.y > window.innerHeight * 0.3 ? 2 : 0);
      if (!best || score > best.score || (score === best.score && r.y > best.y)) {
        best = { x: r.x + r.width / 2, y: r.y + r.height / 2, score, cls: cls.slice(0, 60) };
      }
    }
    return best && best.score >= 2 ? best : null;
  });
  if (pos) {
    return { kind: 'slider', handle: null, selector: `heuristic:${pos.cls}`, start: { x: pos.x, y: pos.y } };
  }

  if (/滑块|向右滑动|拖动|slide to|drag the slider/i.test(body)) {
    return { kind: 'slider_text', handle: null, selector: 'text' };
  }
  return null;
}

/**
 * Solve slider without AI.
 */
export async function solveSliderTraditional(page, onLog = () => {}) {
  const log = (m) => {
    console.log(`[SliderCaptcha] ${m}`);
    onLog(m);
  };

  const det = await detectSliderImpl(page);
  if (!det) return { ok: false, error: 'no slider UI detected' };

  log(`detected slider via ${det.selector}`);

  let start = det.start;
  if (!start && det.handle) {
    const hb = await det.handle.boundingBox();
    if (!hb) return { ok: false, error: 'handle has no box' };
    start = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
  }
  if (!start) {
    // last resort: bottom-center of modal
    const modal = page.locator('.yoda-modal-content, #yodaVerify').first();
    const mb = await modal.boundingBox();
    if (!mb) return { ok: false, error: 'no drag start point' };
    start = { x: mb.x + 30, y: mb.y + mb.height - 28 };
    log('using modal bottom-left as handle start');
  }

  // multi-try distances
  let base = await estimateDistance(page, log);
  const candidates = [
    base,
    Math.floor(base * 0.88),
    Math.floor(base * 1.08),
    Math.floor(base * 0.75),
    Math.floor(base * 1.18),
  ];

  for (let i = 0; i < candidates.length; i++) {
    // re-find handle each attempt (DOM may refresh)
    const det2 = await detectSliderImpl(page);
    let s = start;
    if (det2?.handle) {
      const hb = await det2.handle.boundingBox();
      if (hb) s = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
    } else if (det2?.start) {
      s = det2.start;
    }
    const d = candidates[i];
    log(`attempt ${i + 1}/${candidates.length} distance=${d}`);
    await dragBy(page, s, d, log);

    const body = await page.locator('body').innerText().catch(() => '');
    const yodaOpen = await page
      .locator('#yodaVerify .yoda-modal-content:visible, .yoda-slider-wrapper:visible, .yoda-sudoku-wrap:visible')
      .first()
      .isVisible()
      .catch(() => false);
    if (!yodaOpen || !/滑块|slide|connect the dots|tap icons|shortest|安全验证|拖动/i.test(body)) {
      log('slider appears solved');
      return { ok: true, method: 'traditional_slider', distance: d };
    }
    // small pause before retry
    await page.waitForTimeout(400);
  }

  return { ok: false, error: 'slider still present after traditional drags', distance: base };
}
