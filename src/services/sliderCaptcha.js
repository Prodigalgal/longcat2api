/**
 * Traditional slider captcha solver (NO AI).
 * Gap detection by pixel contrast + human-like drag trajectory.
 * Used for Yoda / slide-verify style puzzles.
 */

/**
 * Find horizontal gap offset (px) in background image buffer (PNG/JPEG via raw RGBA).
 * Simple column-energy scan: gap usually has sharp edge / low fill.
 * @param {Uint8ClampedArray|Buffer} rgba
 * @param {number} width
 * @param {number} height
 * @param {{ blockWidth?: number }} opts
 */
export function findGapOffset(rgba, width, height, opts = {}) {
  const blockW = Math.max(30, Math.min(80, opts.blockWidth || Math.floor(width * 0.18)));
  // Skip left area where piece starts
  const startX = Math.floor(width * 0.15);
  const endX = width - blockW - 2;
  let bestX = startX;
  let bestScore = -1;

  for (let x = startX; x < endX; x++) {
    let edge = 0;
    // sample middle band vertically
    const y0 = Math.floor(height * 0.25);
    const y1 = Math.floor(height * 0.75);
    for (let y = y0; y < y1; y++) {
      const i = (y * width + x) * 4;
      const j = (y * width + x + 1) * 4;
      const d =
        Math.abs(rgba[i] - rgba[j]) +
        Math.abs(rgba[i + 1] - rgba[j + 1]) +
        Math.abs(rgba[i + 2] - rgba[j + 2]);
      edge += d;
    }
    // also score "hole" darkness variance in a vertical strip
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let dx = 0; dx < 3; dx++) {
        const i = (y * width + x + dx) * 4;
        const g = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
        sum += g;
        sum2 += g * g;
        n++;
      }
    }
    const mean = sum / n;
    const variance = sum2 / n - mean * mean;
    const score = edge + variance * 2;
    if (score > bestScore) {
      bestScore = score;
      bestX = x;
    }
  }
  // offset from left where piece should move to
  return Math.max(10, Math.min(width - blockW - 5, bestX - Math.floor(blockW * 0.15)));
}

/**
 * Human-like trajectory from 0 → distance (px).
 * Returns list of {x, y, t} relative offsets.
 */
export function buildDragTrack(distance) {
  const dist = Math.max(20, Math.floor(distance));
  const points = [];
  // ease-out with slight overshoot
  const steps = 28 + Math.floor(Math.random() * 10);
  let x = 0;
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    // cubic ease
    const ease = 1 - Math.pow(1 - p, 3);
    x = dist * ease;
    // y jitter
    const y = (Math.random() - 0.5) * 3;
    points.push({ x, y, t: 8 + Math.random() * 12 });
  }
  // small overshoot then settle
  points.push({ x: dist + 4 + Math.random() * 4, y: 0, t: 30 });
  points.push({ x: dist - 2, y: 0, t: 40 });
  points.push({ x: dist, y: 0, t: 50 });
  return points;
}

/**
 * Detect if current page shows a classic slider (not sudoku/connect-dots).
 */
export async function detectSlider(page) {
  const sels = [
    '.slider-move-btn',
    '.yoda-slider-btn',
    '.slide-verify-slider-mask-item',
    '.handler',
    '.slider-btn',
    '[class*="slider-btn"]',
    '[class*="slide-btn"]',
    '.yoda-slider-wrapper .slider',
    '#yodaBox .slider',
  ];
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      return { kind: 'slider', handle: loc, selector: sel };
    }
  }
  // structural: has track + movable piece
  const track = page.locator('[class*="slider-move"], [class*="slide-verify"], .yoda-slider-wrapper').first();
  if (await track.isVisible().catch(() => false)) {
    const handle = track.locator('[class*="btn"], [class*="handler"], [class*="block"]').first();
    if (await handle.isVisible().catch(() => false)) {
      return { kind: 'slider', handle, selector: 'track>btn' };
    }
  }
  const body = await page.locator('body').innerText().catch(() => '');
  if (/slide|拖动|滑块|向右滑动|drag the slider/i.test(body) && !/connect the dots|tap icons|shortest line/i.test(body)) {
    return { kind: 'slider_text', handle: null, selector: 'text' };
  }
  return null;
}

/**
 * Solve slider without AI: screenshot puzzle area, find gap, drag handle.
 * @returns {{ ok: boolean, method?: string, error?: string, distance?: number }}
 */
export async function solveSliderTraditional(page, onLog = () => {}) {
  const det = await detectSlider(page);
  if (!det) return { ok: false, error: 'no slider UI' };

  const log = (m) => {
    console.log(`[SliderCaptcha] ${m}`);
    onLog(m);
  };

  // Find images: bg + piece
  const bg = page
    .locator(
      '.yoda-slider-bg img, .slide-verify-bg img, [class*="slider"] img.bg, .yoda-box img, #yodaBox img, .yoda-modal-content img'
    )
    .first();
  const piece = page
    .locator(
      '.yoda-slider-block img, .slide-verify-block img, [class*="slider"] img.block, .yoda-slider-wrapper img'
    )
    .nth(1);

  let distance = null;

  // Try canvas if present
  const canvas = page.locator('#yodaVerify canvas, .yoda-modal-content canvas, canvas').first();
  if (await canvas.isVisible().catch(() => false)) {
    try {
      const data = await canvas.evaluate((c) => {
        const ctx = c.getContext('2d');
        const w = c.width || c.clientWidth;
        const h = c.height || c.clientHeight;
        const img = ctx.getImageData(0, 0, w, h);
        return { w, h, data: Array.from(img.data) };
      });
      distance = findGapOffset(Uint8ClampedArray.from(data.data), data.w, data.h);
      log(`gap from canvas: ${distance}px (w=${data.w})`);
    } catch (e) {
      log(`canvas gap fail: ${e.message}`);
    }
  }

  // Try background image element screenshot via page evaluate draw
  if (distance == null && (await bg.isVisible().catch(() => false))) {
    try {
      const box = await bg.boundingBox();
      if (box) {
        const shot = await bg.screenshot({ type: 'png' });
        // decode PNG with pure approach: use createImageBitmap not available in node easily
        // fallback: use playwright + offscreen via page
        const gap = await page.evaluate(async (b64) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: 'image/png' });
          const bmp = await createImageBitmap(blob);
          const c = document.createElement('canvas');
          c.width = bmp.width;
          c.height = bmp.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          // inline simple gap
          const rgba = img.data;
          const width = c.width;
          const height = c.height;
          const blockW = Math.floor(width * 0.18);
          let bestX = Math.floor(width * 0.15);
          let bestScore = -1;
          for (let x = bestX; x < width - blockW; x++) {
            let edge = 0;
            const y0 = Math.floor(height * 0.25);
            const y1 = Math.floor(height * 0.75);
            for (let y = y0; y < y1; y++) {
              const i = (y * width + x) * 4;
              const j = i + 4;
              edge +=
                Math.abs(rgba[i] - rgba[j]) +
                Math.abs(rgba[i + 1] - rgba[j + 1]) +
                Math.abs(rgba[i + 2] - rgba[j + 2]);
            }
            if (edge > bestScore) {
              bestScore = edge;
              bestX = x;
            }
          }
          return { offset: bestX, width, height };
        }, shot.toString('base64'));
        // scale to handle screen pixels
        const handleBox = det.handle ? await det.handle.boundingBox() : null;
        const track = page.locator('[class*="slider"], .yoda-slider-wrapper, .slide-verify').first();
        const trackBox = await track.boundingBox().catch(() => box);
        const scale = trackBox && gap.width ? trackBox.width / gap.width : 1;
        distance = Math.floor(gap.offset * scale);
        // subtract piece start offset roughly
        if (handleBox) distance = Math.max(20, distance - Math.floor(handleBox.width * 0.3));
        log(`gap from bg img: raw=${gap.offset} scaled=${distance}`);
      }
    } catch (e) {
      log(`bg gap fail: ${e.message}`);
    }
  }

  // Fallback fixed ratios (common yoda track lengths)
  if (distance == null || !Number.isFinite(distance) || distance < 15) {
    const track = page.locator('[class*="slider"], .yoda-slider-wrapper, .slide-verify, .yoda-modal-content').first();
    const trackBox = await track.boundingBox().catch(() => null);
    if (trackBox) {
      // try a few candidate distances
      distance = Math.floor(trackBox.width * (0.55 + Math.random() * 0.15));
      log(`gap fallback ratio distance=${distance}`);
    } else {
      distance = 180;
      log(`gap hardcoded distance=${distance}`);
    }
  }

  let handle = det.handle;
  if (!handle || !(await handle.isVisible().catch(() => false))) {
    handle = page
      .locator(
        '.slider-move-btn, .yoda-slider-btn, .handler, .slider-btn, [class*="slider-btn"], [class*="slide-btn"]'
      )
      .first();
  }
  if (!(await handle.isVisible().catch(() => false))) {
    return { ok: false, error: 'slider handle not found' };
  }

  const hbox = await handle.boundingBox();
  if (!hbox) return { ok: false, error: 'no handle box' };

  log(`drag handle by ${distance}px (traditional, no AI)`);
  const startX = hbox.x + hbox.width / 2;
  const startY = hbox.y + hbox.height / 2;
  const track = buildDragTrack(distance);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (const p of track) {
    await page.mouse.move(startX + p.x, startY + p.y, { steps: 2 });
    await new Promise((r) => setTimeout(r, p.t));
  }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 1500));

  // success if yoda prompt gone
  const body = await page.locator('body').innerText().catch(() => '');
  const still =
    /slide|滑块|拖动|connect the dots|tap icons|shortest line|安全验证/i.test(body) &&
    (await page.locator('#yodaVerify, .yoda-verify-container, .yoda-slider-wrapper').first().isVisible().catch(() => false));

  if (!still) {
    log('slider appears solved');
    return { ok: true, method: 'traditional_slider', distance };
  }

  // second attempt with slightly different distance
  const d2 = Math.floor(distance * (0.92 + Math.random() * 0.16));
  log(`retry drag ${d2}px`);
  const hbox2 = await handle.boundingBox();
  if (hbox2) {
    const track2 = buildDragTrack(d2);
    const sx = hbox2.x + hbox2.width / 2;
    const sy = hbox2.y + hbox2.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (const p of track2) {
      await page.mouse.move(sx + p.x, sy + p.y, { steps: 2 });
      await new Promise((r) => setTimeout(r, p.t));
    }
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 1500));
  }

  const body2 = await page.locator('body').innerText().catch(() => '');
  const still2 = await page.locator('#yodaVerify .yoda-modal-content, .yoda-slider-wrapper, canvas.sudoku-canvas').first().isVisible().catch(() => false);
  if (!still2 || !/slide|滑块|connect the dots|tap icons|shortest/i.test(body2)) {
    return { ok: true, method: 'traditional_slider_retry', distance: d2 };
  }
  return { ok: false, error: 'slider still present after traditional drag', distance };
}
