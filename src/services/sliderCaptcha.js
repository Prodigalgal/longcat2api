/**
 * Traditional Yoda puzzle-slider solver (NO cloud AI by default).
 *
 * Gap backends (local, same stack as qwen2api):
 *  - ddddocr slide_match / captcha-recognizer / OpenCV  via scripts/local_captcha_solver.py
 *  - in-page screenshot edge scan fallback
 *
 * Real DOM (2026-07 local dump):
 *  - title: "Please move the slider below to complete the puzzle"
 *  - image: .global-puzzle-slider-image (~296x222)
 *  - piece: .global-puzzle-slider-drag  (absolute, starts left, ~93px wide)
 *  - track: .global-puzzle-slider-box-wrap (~296x44)
 *  - handle: div.box-static (44x44)
 *  - bar:   div.moveing-bar
 *  - refresh: .global-puzzle-slider-operate-refresh
 *
 * Distance/speed tuned like qwen2api/captcha.py:
 *  - gap → display px → clamp to max_travel (track - handle)
 *  - short Bezier drag (~0.45–0.70s), immediate release, no long settle
 */

import { grabYodaSliderImages, solveSliderLocal } from './localCaptcha.js';

function envNum(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
}

/** Cubic Bezier (same idea as qwen2api human_drag_path). */
function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Fast human-like path. Default ~0.55s total (was ~1.5–2.5s before).
 * Returns [{x, y, tMs}, ...] absolute coords.
 */
export function buildDragTrack(startX, startY, distance, durationSec = 0.55) {
  const dist = Math.max(18, Math.min(320, Number(distance) || 0));
  const duration = Math.max(0.32, Math.min(0.85, durationSec));
  // fewer steps = snappier (qwen: ~24–56)
  const steps = Math.max(22, Math.min(48, Math.round(duration * 70)));
  const sx = startX;
  const sy = startY;
  const ex = sx + dist;
  const ey = sy + (Math.random() * 0.8 - 0.4);

  const c1x = sx + dist * (0.18 + Math.random() * 0.14);
  const c2x = sx + dist * (0.62 + Math.random() * 0.18);
  const c1y = sy + (Math.random() * 5 - 2.5);
  const c2y = sy + (Math.random() * 4 - 2);

  const xs = [];
  const ys = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    xs.push(cubicBezier(sx, c1x, c2x, ex, t));
    ys.push(cubicBezier(sy, c1y, c2y, ey, t));
  }
  xs[steps - 1] = ex;
  ys[steps - 1] = ey;

  // path length for velocity profile
  const segs = [0];
  for (let i = 1; i < steps; i++) {
    const dx = xs[i] - xs[i - 1];
    const dy = ys[i] - ys[i - 1];
    segs.push(segs[i - 1] + Math.hypot(dx, dy));
  }
  const totalLen = Math.max(segs[steps - 1], 1e-6);

  // Snappy: short accel, hot cruise, minimal ease-out (qwen feedback)
  const raw = [];
  for (let i = 0; i < steps; i++) {
    const s = segs[i] / totalLen;
    const ds = i > 0 ? segs[i] - segs[i - 1] : totalLen / steps;
    let speed;
    if (s < 0.12) speed = 0.55 + 0.55 * (s / 0.12);
    else if (s > 0.92) speed = 1.05 - 0.2 * ((s - 0.92) / 0.08);
    else speed = 1.18;
    speed = Math.max(0.85, Math.min(1.3, speed));
    raw.push(ds / speed);
  }
  const scale = duration / Math.max(raw.reduce((a, b) => a + b, 0), 1e-6);

  const points = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const tremor = (Math.random() * 0.5 - 0.25) * (1 - t * 0.85);
    const delaySec = Math.max(raw[i] * scale, 0.0008);
    points.push({
      x: xs[i],
      y: ys[i] + tremor,
      tMs: Math.max(1, Math.round(delaySec * 1000)),
    });
  }
  // arrive hot, release ASAP
  points[points.length - 1] = {
    x: ex,
    y: ey,
    tMs: Math.min(points[points.length - 1].tMs, 4),
  };
  return points;
}

export async function detectSlider(page) {
  const primary = page.locator('div.box-static, .box-static').first();
  if (await primary.isVisible().catch(() => false)) {
    return { kind: 'slider', handle: primary, selector: 'div.box-static' };
  }

  for (const sel of [
    '.global-puzzle-slider-box-wrap .box-static',
    'div.moveing-bar',
    '.yoda-slider-btn',
    '.slider-move-btn',
    '.handler',
    '[class*="slider-btn"]',
    '[class*="slide-btn"]',
  ]) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      return { kind: 'slider', handle: loc, selector: sel };
    }
  }

  const pos = await page.evaluate(() => {
    const root =
      document.querySelector(
        '.global-puzzle-main, #yodaVerify, .yoda-verify-container, .yoda-modal-content'
      ) || document.body;
    let best = null;
    for (const el of root.querySelectorAll('div,button,span')) {
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.width > 60 || r.height < 30 || r.height > 60) continue;
      const st = getComputedStyle(el);
      if (st.cursor !== 'move' && st.cursor !== 'grab' && st.cursor !== 'pointer') continue;
      const cls = (el.className || '').toString();
      if (/close|refresh|icon/i.test(cls)) continue;
      best = {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        cls: cls.slice(0, 80),
      };
      if (/box-static|slider|handler|move/i.test(cls)) break;
    }
    return best;
  });
  if (pos) {
    return {
      kind: 'slider',
      handle: null,
      selector: `cursor:${pos.cls}`,
      start: { x: pos.x, y: pos.y },
    };
  }

  const body = await page.locator('body').innerText().catch(() => '');
  if (/move the slider|slider below|complete the puzzle|滑块|向右滑动|拖动/i.test(body)) {
    return { kind: 'slider_text', handle: null, selector: 'text' };
  }
  return null;
}

/**
 * Read track geometry + piece position from Yoda DOM.
 * max_travel = track.width - handle.width  (≈ 252 on 296 track / 44 handle)
 */
async function readSliderGeometry(page) {
  return page.evaluate(() => {
    const track =
      document.querySelector('.global-puzzle-slider-box-wrap') ||
      document.querySelector('.global-puzzle-main');
    const handle = document.querySelector('div.box-static');
    const piece = document.querySelector('.global-puzzle-slider-drag');
    const imgWrap =
      document.querySelector('.global-puzzle-slider-image') ||
      document.querySelector('.global-puzzle-main');

    const tb = track?.getBoundingClientRect();
    const hb = handle?.getBoundingClientRect();
    const pb = piece?.getBoundingClientRect();
    const ib = imgWrap?.getBoundingClientRect();

    if (!tb || !hb || tb.width < 80) return null;

    const maxTravel = Math.max(40, tb.width - hb.width);
    const pieceLeft = pb && ib ? pb.x - ib.x : 0;
    const pieceW = pb?.width || 0;

    return {
      trackW: tb.width,
      trackX: tb.x,
      handleW: hb.width,
      handleX: hb.x,
      handleY: hb.y,
      maxTravel,
      pieceLeft,
      pieceW,
      imgW: ib?.width || tb.width,
      imgH: ib?.height || 0,
      imgX: ib?.x || tb.x,
      imgY: ib?.y || tb.y,
    };
  });
}

/**
 * Analyze clean bg PNG (piece hidden) for hole LEFT edge in CSS px.
 *
 * Key insight from captcha-once logs: plain max-edge picks the hole RIGHT rim
 * (~213) while true left is ~204 or lower. Fix: score a sliding window of
 * width ≈ pieceW (dark/flat interior + strong left edge + strong right edge).
 */
async function analyzeGapPng(page, png, cssW, pieceWCss, onLog) {
  const log = onLog || (() => {});
  const b64 = png.toString('base64');
  const gap = await page.evaluate(
    ({ b64, pieceWCss, cssW }) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            if (w < 40 || h < 40) return resolve(null);
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, w, h).data;
            const scale = w / Math.max(1, cssW);
            // piece width in native px; clamp to sane range
            let piecePx = Math.floor((pieceWCss || 90) * scale);
            if (piecePx < 40) piecePx = Math.floor(w * 0.28);
            if (piecePx > w * 0.5) piecePx = Math.floor(w * 0.32);

            const y0 = Math.floor(h * 0.15);
            const y1 = Math.floor(h * 0.85);
            const rowH = Math.max(1, y1 - y0);

            // per-column luminance mean + horizontal edge energy
            const lum = new Float64Array(w);
            const edge = new Float64Array(w);
            for (let x = 0; x < w; x++) {
              let sum = 0;
              let e = 0;
              let n = 0;
              for (let y = y0; y < y1; y += 2) {
                const i = (y * w + x) * 4;
                const L = (data[i] + data[i + 1] + data[i + 2]) / 3;
                sum += L;
                if (x + 1 < w) {
                  const j = (y * w + x + 1) * 4;
                  const L2 = (data[j] + data[j + 1] + data[j + 2]) / 3;
                  e += Math.abs(L - L2);
                }
                n++;
              }
              lum[x] = sum / Math.max(1, n);
              edge[x] = e / Math.max(1, n);
            }

            // smooth edge
            const edgeS = new Float64Array(w);
            for (let x = 2; x < w - 2; x++) {
              edgeS[x] =
                edge[x - 2] * 0.1 +
                edge[x - 1] * 0.2 +
                edge[x] * 0.4 +
                edge[x + 1] * 0.2 +
                edge[x + 2] * 0.1;
            }

            // Sliding window of width piecePx: hole = darker interior + left & right rims
            // Search left edge from past home strip to where window still fits before right frame
            const xLeftMin = Math.max(Math.floor(w * 0.16), Math.floor(piecePx * 0.35));
            const xLeftMax = Math.min(Math.floor(w * 0.72), w - piecePx - 4);

            let bestLeft = Math.floor((xLeftMin + xLeftMax) / 2);
            let bestScore = -1e18;
            let bestDetail = null;

            // global mean lum for relative darkness
            let gLum = 0;
            for (let x = xLeftMin; x < xLeftMax + piecePx; x++) gLum += lum[x];
            gLum /= Math.max(1, xLeftMax + piecePx - xLeftMin);

            for (let left = xLeftMin; left <= xLeftMax; left++) {
              const right = left + piecePx;
              // interior darkness (hole is usually darker than surroundings)
              let interior = 0;
              const mid0 = left + Math.floor(piecePx * 0.2);
              const mid1 = left + Math.floor(piecePx * 0.8);
              for (let x = mid0; x < mid1; x++) interior += lum[x];
              interior /= Math.max(1, mid1 - mid0);
              const dark = Math.max(0, gLum - interior); // larger = darker hole

              // left rim edge strength (hole left boundary)
              let leftEdge = 0;
              for (let x = left - 2; x <= left + 3; x++) {
                if (x >= 0 && x < w) leftEdge = Math.max(leftEdge, edgeS[x]);
              }
              // right rim edge strength
              let rightEdge = 0;
              for (let x = right - 3; x <= right + 2; x++) {
                if (x >= 0 && x < w) rightEdge = Math.max(rightEdge, edgeS[x]);
              }

              // BOTH rims required: reject if left rim is weak vs right (classic right-rim false hit)
              if (leftEdge < rightEdge * 0.35 && leftEdge < 8) continue;
              // prefer BOTH rims + dark interior; slight left bias
              const posBias = 1 - 0.12 * ((left - xLeftMin) / Math.max(1, xLeftMax - xLeftMin));
              const score =
                dark * 3.0 +
                leftEdge * 1.4 +
                rightEdge * 0.7 +
                Math.min(leftEdge, rightEdge) * 0.8;
              const final = score * posBias;

              if (final > bestScore) {
                bestScore = final;
                bestLeft = left;
                bestDetail = { dark, leftEdge, rightEdge, interior, right };
              }
            }

            // Snap to strongest edge peak in a small neighborhood of left rim
            let refined = bestLeft;
            let peakE = edgeS[bestLeft] || 0;
            for (let x = Math.max(xLeftMin, bestLeft - 6); x <= Math.min(xLeftMax, bestLeft + 4); x++) {
              if (edgeS[x] > peakE) {
                peakE = edgeS[x];
                refined = x;
              }
            }

            const gapLeftCss = refined / scale;
            resolve({
              gapXNative: refined,
              gapLeftCss,
              cssW,
              nativeW: w,
              nativeH: h,
              score: bestScore,
              scale,
              piecePx,
              windowRight: bestDetail?.right,
              dark: bestDetail?.dark,
              leftEdge: bestDetail?.leftEdge,
              rightEdge: bestDetail?.rightEdge,
            });
          } catch (e) {
            resolve({ error: String(e?.message || e) });
          }
        };
        img.onerror = () => resolve(null);
        img.src = `data:image/png;base64,${b64}`;
      }),
    { b64, pieceWCss, cssW }
  );
  if (gap?.error) {
    log(`gap analyze error: ${gap.error}`);
    return null;
  }
  if (gap?.gapLeftCss != null && Number.isFinite(gap.gapLeftCss)) {
    if (gap.gapLeftCss / cssW > 0.75) {
      log(`gap rejected near-right leftCss=${gap.gapLeftCss.toFixed(1)}/${cssW}`);
      return null;
    }
    log(
      `gap window leftCss=${gap.gapLeftCss.toFixed(1)} nativeX=${gap.gapXNative} piecePx=${gap.piecePx} dark=${Number(gap.dark || 0).toFixed(1)} Ledge=${Number(gap.leftEdge || 0).toFixed(1)} Redge=${Number(gap.rightEdge || 0).toFixed(1)} cssW=${cssW.toFixed?.(1) ?? cssW}`
    );
    return { ...gap, method: 'clean_window' };
  }
  return null;
}

/**
 * Map hole left → ABSOLUTE target piece-left + open-loop drag estimate.
 *
 * Yoda physics (local dump):
 *  - piece `.global-puzzle-slider-drag` left tracks handle ~1:1 in CSS px
 *  - success when piece left edge ≈ hole left edge
 *  - targetPiece = absolute piece-left (NOT a delta)
 *  - drag ≈ targetPiece - currentPieceLeft
 */
export function mapGapToDrag({
  gapLeftCss,
  pieceLeft = 0,
  maxTravel,
  imgW = 0,
  pieceW = 0,
  pieceOffset = 0,
  fudgePx = 0,
}) {
  const gap = Number(gapLeftCss);
  const cur = Math.max(0, Number(pieceLeft) || 0);
  // The Yoda moving element is a tall strip. Align the visible jigsaw inside
  // that strip with the hole, rather than aligning the strip's left edge.
  const innerOffset = Math.max(0, Number(pieceOffset) || 0);
  let targetPiece = gap - innerOffset + Number(fudgePx || 0);
  // The visible piece, not the full moving strip, must remain in the image.
  if (imgW > 0 && pieceW > 0) {
    const pieceMax = Math.max(40, imgW - innerOffset - pieceW - 1);
    targetPiece = Math.min(targetPiece, pieceMax);
  }
  targetPiece = Math.max(0, Math.min(maxTravel - 2, targetPiece));
  // open-loop drag from current piece position (handle tracks piece ~1:1)
  let drag = (targetPiece - cur) * envNum('LONGCAT2API_SLIDER_DIST_SCALE', 1.0);
  drag = Math.max(18, Math.min(maxTravel - 2, drag));
  return { drag, targetPiece };
}

/**
 * Clean-bg screenshot + edge analysis (piece hidden so left overlay / right frame
 * cannot steal the peak). Primary JS fallback when local Python fails.
 */
async function estimateGapDisplay(page, onLog, pieceWCss) {
  const log = onLog || (() => {});
  const geo = await readSliderGeometry(page);
  if (!geo?.imgW) {
    log('gap: no geometry');
    return null;
  }
  try {
    // hide floating piece/handle so hole is the only strong vertical edge
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

    let png = null;
    try {
      const loc = page.locator('.global-puzzle-slider-image, .global-puzzle-main').first();
      if (await loc.isVisible().catch(() => false)) {
        png = await loc.screenshot({ type: 'png', timeout: 4000 }).catch(() => null);
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

    if (!png?.length) {
      log('gap: clean screenshot empty');
      return null;
    }
    return analyzeGapPng(page, png, geo.imgW, pieceWCss || geo.handleW || 44, log);
  } catch (e) {
    log(`gap estimate err: ${e.message}`);
    return null;
  }
}

async function getHandleStart(page, det) {
  if (det?.handle) {
    const b = await det.handle.boundingBox({ timeout: 1200 }).catch(() => null);
    if (b) return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width };
  }
  if (det?.start) return { ...det.start, w: 44 };

  const pos = await page.evaluate(() => {
    const prefer = document.querySelector('div.box-static');
    if (prefer) {
      const r = prefer.getBoundingClientRect();
      if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
    }
    for (const el of document.querySelectorAll('div,button,span')) {
      const r = el.getBoundingClientRect();
      if (r.width < 34 || r.width > 56 || r.height < 34 || r.height > 56) continue;
      const st = getComputedStyle(el);
      if (st.cursor === 'move' || st.cursor === 'grab') {
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
      }
    }
    return null;
  });
  return pos;
}

/**
 * Live piece left edge relative to puzzle image (CSS px).
 * This is the ground truth for closed-loop drag (qwen-style).
 */
async function readPieceLeft(page) {
  return page.evaluate(() => {
    const p = document.querySelector('.global-puzzle-slider-drag');
    const img =
      document.querySelector('.global-puzzle-slider-image') ||
      document.querySelector('.global-puzzle-main');
    if (!p || !img) return null;
    return p.getBoundingClientRect().x - img.getBoundingClientRect().x;
  });
}

/**
 * Closed-loop drag with grab verification.
 * Logs showed piece stuck at 0 while mouse moved → grab never engaged.
 * Fix: longer press, steps with mouse.steps, abort+retry if piece doesn't move.
 */
async function dragClosedLoop(page, start, targetPieceLeft, maxTravel, onLog) {
  const log = onLog || (() => {});
  const tol = envNum('LONGCAT2API_SLIDER_TOL_PX', 1.0);
  const budgetMs = envNum('LONGCAT2API_SLIDER_LOOP_MS', 1400);
  const kickFrac = envNum('LONGCAT2API_SLIDER_KICK_FRAC', 0.82);

  let target = Math.max(0, Math.min(maxTravel - 1, targetPieceLeft));
  const kick = Math.max(20, Math.min(maxTravel * 0.88, target * kickFrac));
  const piece0 = (await readPieceLeft(page)) ?? 0;

  log(
    `closed-loop targetPiece=${target.toFixed(1)} kick=${kick.toFixed(1)} maxTravel=${maxTravel.toFixed?.(1) ?? maxTravel} tol=${tol} piece0=${piece0.toFixed(1)}`
  );

  // Approach + firm press (Camoufox needs slightly longer hold to grab)
  await page.mouse.move(start.x - 12 - Math.random() * 8, start.y + (Math.random() * 2 - 1));
  await page.waitForTimeout(20);
  await page.mouse.move(start.x, start.y, { steps: 3 });
  await page.waitForTimeout(30);
  await page.mouse.down();
  await page.waitForTimeout(45);

  // Phase A: kick with multi-step moves so browser emits mousemove stream
  const kickSteps = Math.max(12, Math.floor(kick / 7));
  let mouseX = start.x;
  for (let i = 1; i <= kickSteps; i++) {
    const t = i / kickSteps;
    const e = t * t * (3 - 2 * t);
    mouseX = start.x + kick * e;
    await page.mouse.move(mouseX, start.y + (Math.random() * 0.6 - 0.3), { steps: 2 });
    await page.waitForTimeout(6);
  }

  // Verify grab: if piece barely moved, re-grab once
  let midPiece = (await readPieceLeft(page)) ?? piece0;
  if (midPiece - piece0 < 8 && kick > 25) {
    log(`grab weak pieceΔ=${(midPiece - piece0).toFixed(1)} → re-grab`);
    await page.mouse.up();
    await page.waitForTimeout(40);
    // re-read handle (may have moved slightly)
    const h = await page.evaluate(() => {
      const el = document.querySelector('div.box-static');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const sx = h?.x ?? start.x;
    const sy = h?.y ?? start.y;
    await page.mouse.move(sx, sy, { steps: 2 });
    await page.waitForTimeout(25);
    await page.mouse.down();
    await page.waitForTimeout(50);
    // open-loop remainder toward target
    const rem = Math.max(12, target - ((await readPieceLeft(page)) ?? 0));
    const remSteps = Math.max(10, Math.floor(rem / 6));
    mouseX = sx;
    for (let i = 1; i <= remSteps; i++) {
      const t = i / remSteps;
      mouseX = sx + rem * t;
      await page.mouse.move(mouseX, sy + (Math.random() * 0.5 - 0.25), { steps: 2 });
      await page.waitForTimeout(7);
    }
    midPiece = (await readPieceLeft(page)) ?? midPiece;
  }

  // Phase B: live correct
  let gain = 1.05;
  let lastPiece = midPiece;
  let lastMouse = mouseX;
  let samples = 0;
  let stableHits = 0;
  let noMoveStreak = 0;
  const limit = start.x + maxTravel + 6;
  const t0 = Date.now();

  while (Date.now() - t0 < budgetMs && samples < 55) {
    const piece = await readPieceLeft(page);
    if (piece == null) break;
    const err = target - piece;

    if (Math.abs(err) <= tol) {
      stableHits++;
      if (stableHits >= 2) {
        await page.mouse.up();
        log(
          `RELEASE aligned piece=${piece.toFixed(1)} target=${target.toFixed(1)} err=${err.toFixed(1)} samples=${samples} ${Date.now() - t0}ms`
        );
        await page.waitForTimeout(220 + Math.random() * 80);
        return { ok: true, piece, samples, moved: piece - piece0 };
      }
      await page.waitForTimeout(10);
      samples++;
      continue;
    }
    stableHits = 0;

    const dPiece = piece - lastPiece;
    const dMouse = mouseX - lastMouse;
    if (Math.abs(dPiece) < 0.3 && Math.abs(dMouse) > 2) {
      noMoveStreak++;
    } else {
      noMoveStreak = 0;
    }
    // piece not tracking mouse → stop wasting time
    if (noMoveStreak >= 8 && piece < 5) {
      await page.mouse.up();
      log(`RELEASE no-grab piece=${piece.toFixed(1)} (stuck)`);
      return { ok: false, piece, samples, moved: piece - piece0, noGrab: true };
    }

    if (Math.abs(dPiece) > 0.6 && Math.abs(dMouse) > 0.5) {
      const inst = Math.abs(dMouse) / Math.abs(dPiece);
      gain = 0.6 * gain + 0.4 * Math.max(0.8, Math.min(inst, 1.8));
    }
    lastPiece = piece;
    lastMouse = mouseX;

    let step;
    const aerr = Math.abs(err);
    if (aerr > 30) step = err * gain * 0.55;
    else if (aerr > 12) step = err * gain * 0.42;
    else if (aerr > 5) step = err * gain * 0.32;
    else step = err * gain * 0.22;

    step = Math.max(-16, Math.min(16, step));
    if (Math.abs(step) < 0.5) step = err > 0 ? 0.6 : -0.6;

    mouseX = Math.max(start.x - 2, Math.min(limit, mouseX + step));
    await page.mouse.move(mouseX, start.y + (Math.random() * 0.4 - 0.2), { steps: 1 });
    await page.waitForTimeout(7);
    samples++;
  }

  await page.mouse.up();
  const final = (await readPieceLeft(page)) ?? lastPiece;
  const finalErr = final - target;
  log(
    `RELEASE timeout piece=${final.toFixed(1)} target=${target.toFixed(1)} err=${finalErr.toFixed(1)} samples=${samples} gain=${gain.toFixed(2)} moved=${(final - piece0).toFixed(1)}`
  );
  await page.waitForTimeout(200);
  return {
    ok: Math.abs(finalErr) <= tol * 2.5,
    piece: final,
    samples,
    moved: final - piece0,
    noGrab: final - piece0 < 5,
  };
}

/** Open-loop fallback — used when closed-loop fails to grab or piece unreadable */
async function dragFast(page, start, distance, onLog) {
  const log = onLog || (() => {});
  const duration = envNum('LONGCAT2API_SLIDER_DRAG_SEC', 0.55);
  const dist = Math.max(18, Math.min(320, Number(distance) || 0));
  const track = buildDragTrack(start.x, start.y, dist, duration);
  log(`open-loop drag ${Math.round(dist)}px`);
  await page.mouse.move(start.x - 10, start.y);
  await page.waitForTimeout(15);
  await page.mouse.move(start.x, start.y, { steps: 3 });
  await page.waitForTimeout(25);
  await page.mouse.down();
  await page.waitForTimeout(40);
  for (const p of track) {
    await page.mouse.move(p.x, p.y, { steps: 1 });
    if (p.tMs > 1) await page.waitForTimeout(p.tMs);
  }
  await page.mouse.up();
  await page.waitForTimeout(280);
  const piece = await readPieceLeft(page);
  return { ok: false, piece, samples: track.length, moved: piece };
}

function stillHasPuzzle(text) {
  return /move the slider|slider below|complete the puzzle|connect the dots|tap icons|shortest line|滑块|安全验证/i.test(
    text || ''
  );
}

async function sliderStillPresent(page, text = '') {
  if (stillHasPuzzle(text)) return true;
  return !!(await detectSlider(page));
}

async function waitForSliderResolution(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const text = await page.locator('body').innerText().catch(() => '');
    if (!(await sliderStillPresent(page, text))) return true;
    await page.waitForTimeout(150);
  } while (Date.now() < deadline);
  return false;
}

async function readPuzzleKey(page) {
  return page.evaluate(() => {
    const code = document.querySelector('.global-puzzle-slider-operate-code')?.textContent?.trim();
    if (code) return code;
    const image = document.querySelector('.global-puzzle-slider-image');
    if (!image) return '';
    return `${image.id || ''}|${getComputedStyle(image).backgroundImage || ''}`;
  }).catch(() => '');
}

async function clickRefresh(page) {
  const sels = [
    '.global-puzzle-slider-operate-refresh',
    '.sudoku-operate-refresh',
    'img[alt="refresh"]',
    '[class*="refresh"]',
  ];
  for (const s of sels) {
    const loc = page.locator(s).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 1200 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/**
 * Estimate gap / drag:
 *  1) local Python (ddddocr/opencv/recognizer) on clean bg + piece
 *  2) clean-bg JS edge scan (piece hidden)
 *  3) mid-track fallback (closed-loop still corrects)
 */
export async function estimateDistance(page, onLog) {
  const log = onLog || (() => {});
  const geo = await readSliderGeometry(page);
  const maxTravel = geo?.maxTravel || envNum('LONGCAT2API_SLIDER_MAX_TRAVEL', 252);
  const pieceLeft = Math.max(0, geo?.pieceLeft || 0);
  const pieceContainerW = geo?.pieceW || 90;
  const fallbackPieceW = Math.min(
    pieceContainerW,
    Math.max(32, geo?.handleW || pieceContainerW * 0.5)
  );
  const fallbackPieceOffset = Math.max(0, (pieceContainerW - fallbackPieceW) / 2);
  const imgW = geo?.imgW || 296;
  // Default fudge 0 — closed-loop aligns; old -6 systematically undershot.
  const fudge = envNum('LONGCAT2API_SLIDER_FUDGE_PX', 0);

  /** @returns {number|null} sanitized gap css, or null if reject */
  const sanitizeGap = (
    gapLeftCss,
    label,
    visualPieceW = fallbackPieceW
  ) => {
    if (!Number.isFinite(gapLeftCss)) return null;
    // hole never lives under the home piece strip
    if (gapLeftCss < fallbackPieceW * 0.55) {
      log(`${label} reject too-left gap=${gapLeftCss.toFixed(1)} (pieceW=${fallbackPieceW.toFixed?.(1) ?? fallbackPieceW})`);
      return null;
    }
    const holeLeftMax = Math.max(40, imgW - visualPieceW - 1);
    // Far past the visible piece boundary is a right-frame false peak.
    if (gapLeftCss > holeLeftMax + 8) {
      log(
        `${label} reject beyond holeMax gap=${gapLeftCss.toFixed(1)} holeMax=${holeLeftMax.toFixed(1)} imgW=${imgW} pieceW=${visualPieceW.toFixed?.(1) ?? visualPieceW}`
      );
      return null;
    }
    if (gapLeftCss > holeLeftMax) {
      log(
        `${label} clamp gap ${gapLeftCss.toFixed(1)} → ${holeLeftMax.toFixed(1)} (holeMax)`
      );
      return holeLeftMax;
    }
    if (gapLeftCss / imgW > 0.78) {
      log(`${label} reject near-right gap=${gapLeftCss.toFixed(1)}/${imgW}`);
      return null;
    }
    return gapLeftCss;
  };

  // --- local mature solvers first (clean bg + piece) ---
  try {
    const imgs = await grabYodaSliderImages(page);
    if (imgs?.bgPng?.length) {
      const local = await solveSliderLocal(imgs);
      if (local?.ok && local.gap_x != null) {
        const natW = local.natural_width || imgW;
        const scale = imgW / Math.max(1, natW);
        const rawGap = Number(local.gap_x) * scale;
        const hasGeometry = !!local.piece_geometry_detected;
        const pieceOffset = hasGeometry
          ? Number(local.piece_offset_x || 0) * scale
          : fallbackPieceOffset;
        const pieceVisualW = hasGeometry
          ? Number(local.piece_visual_width || fallbackPieceW) * scale
          : fallbackPieceW;
        const gapLeftCss = sanitizeGap(
          rawGap,
          `local[${(local.methods || []).join('+')}]`,
          pieceVisualW
        );
        if (gapLeftCss != null) {
          const { drag, targetPiece } = mapGapToDrag({
            gapLeftCss,
            pieceLeft,
            maxTravel,
            imgW,
            pieceW: pieceVisualW,
            pieceOffset,
            fudgePx: fudge,
          });
          log(
            `local[${(local.methods || []).join('+') || 'solver'}] gap_x=${local.gap_x} conf=${Number(local.confidence || 0).toFixed(2)} scale=${scale.toFixed(3)} gapCss=${gapLeftCss.toFixed(1)} pieceOffset=${pieceOffset.toFixed(1)} pieceW=${pieceVisualW.toFixed(1)} geometry=${!!local.piece_geometry_detected} → target=${targetPiece.toFixed(1)} drag=${drag.toFixed(1)} src=${imgs.source}`
          );
          return {
            distance: drag,
            maxTravel,
            pieceLeft,
            gapLeftCss,
            targetPiece,
            geo,
            method: 'local_' + (local.methods || ['solver']).join('+'),
          };
        }
      } else {
        log(`local slider fail: ${local?.error || 'no gap'}`);
      }
    }
  } catch (e) {
    log(`local slider err: ${e.message}`);
  }

  const gap = await estimateGapDisplay(page, log, fallbackPieceW);
  const gapCss = gap?.gapLeftCss != null ? sanitizeGap(gap.gapLeftCss, 'edge_shot') : null;
  if (gapCss != null) {
    const { drag, targetPiece } = mapGapToDrag({
      gapLeftCss: gapCss,
      pieceLeft,
      maxTravel,
      imgW,
      pieceW: fallbackPieceW,
      pieceOffset: fallbackPieceOffset,
      fudgePx: fudge,
    });
    log(
      `map gapLeft=${gapCss.toFixed(1)} pieceLeft=${Number(pieceLeft).toFixed(1)} maxTravel=${Number(maxTravel).toFixed(1)} fudge=${fudge} → target=${targetPiece.toFixed(1)} drag=${drag.toFixed(1)}`
    );
    return {
      distance: drag,
      maxTravel,
      pieceLeft,
      gapLeftCss: gapCss,
      targetPiece,
      geo,
      method: 'edge_shot',
    };
  }

  // Fallback mid-track — closed-loop will still try to land if we re-estimate badly
  const fallbackTarget = Math.floor(maxTravel * 0.45);
  const { drag, targetPiece } = mapGapToDrag({
    gapLeftCss: fallbackTarget,
    pieceLeft,
    maxTravel,
    imgW,
    pieceW: fallbackPieceW,
    pieceOffset: fallbackPieceOffset,
    fudgePx: 0,
  });
  log(`gap fallback target=${targetPiece} drag=${drag} maxTravel=${maxTravel}`);
  return {
    distance: drag,
    maxTravel,
    pieceLeft,
    gapLeftCss: null,
    targetPiece,
    geo,
    method: 'fallback',
  };
}

/**
 * Solve slider with minimal refreshes (user: frequent refresh → risk control).
 * Strategy:
 *  - estimate gap ONCE per puzzle
 *  - 2–3 drag tries with small target offsets (same puzzle, no refresh)
 *  - at most 1 refresh for a second estimate, then 2 more drags
 *  - if handle mid-track: re-drag from current position (no refresh) or one reset
 */
export async function solveSliderTraditional(page, onLog = () => {}) {
  const log = (m) => {
    console.log(`[SliderCaptcha] ${m}`);
    if (typeof onLog === 'function') onLog(m);
  };

  const det = await detectSlider(page);
  if (!det) return { ok: false, error: 'no slider UI (.box-static missing?)' };
  log(`detected via ${det.selector}`);

  // Hard cap: max 1 refresh per solve (was refresh-every-miss → risk ban)
  const maxRefresh = Math.max(0, Math.min(2, envNum('LONGCAT2API_SLIDER_MAX_REFRESH', 1)));
  let refreshes = 0;

  let est = await estimateDistance(page, log);
  let maxTravel = est.maxTravel;

  // Same-puzzle nudges first (no refresh). Then optional one refresh + 2 more.
  // Total attempts kept small to avoid risk.
  const phases = [
    { refresh: false, offsets: [0, -3, 3] },
    { refresh: true, offsets: [0, -3] },
  ];

  let attempt = 0;
  let forcedOffset = null;
  for (const phase of phases) {
    if (phase.refresh) {
      if (refreshes >= maxRefresh) break;
      const bodyCheck = await page.locator('body').innerText().catch(() => '');
      if (!(await sliderStillPresent(page, bodyCheck))) {
        return { ok: true, method: 'traditional_slider_preclear', distance: 0 };
      }
      const refreshed = await clickRefresh(page);
      refreshes++;
      log(
        refreshed
          ? `refresh #${refreshes}/${maxRefresh} (new puzzle)`
          : `refresh #${refreshes} control missing`
      );
      await page.waitForTimeout(700 + Math.random() * 300);
      if (await waitForSliderResolution(page, 1200)) {
        return { ok: true, method: 'traditional_slider_refresh_clear', distance: 0 };
      }
      const det2 = await detectSlider(page);
      if (det2?.handle) det.handle = det2.handle;
      est = await estimateDistance(page, log);
      maxTravel = est.maxTravel;
    }

    for (const configuredOffset of phase.offsets) {
      const off = forcedOffset ?? configuredOffset;
      forcedOffset = null;
      attempt++;
      if (page.isClosed?.()) return { ok: false, error: 'page closed' };

      const body0 = await page.locator('body').innerText().catch(() => '');
      if (!(await sliderStillPresent(page, body0))) {
        log('puzzle already gone');
        return { ok: true, method: 'traditional_slider_preclear', distance: 0 };
      }

      let start = await getHandleStart(page, det);
      if (!start) {
        log('handle start not found');
        return { ok: false, error: 'slider handle not found' };
      }

      const geoNow = await readSliderGeometry(page);
      const handleOff = geoNow ? geoNow.handleX - geoNow.trackX : 0;
      // Handle mid-track: do NOT auto-refresh (risk). Re-drag from current if possible,
      // else one allowed refresh only.
      if (handleOff > 25) {
        log(`handle mid-track offset=${handleOff.toFixed(0)}`);
        if (await waitForSliderResolution(page, 1200)) {
          return { ok: true, method: 'traditional_slider_delayed_clear', distance: 0 };
        }
        if (refreshes < maxRefresh) {
          await clickRefresh(page);
          refreshes++;
          log(`refresh #${refreshes}/${maxRefresh} to reset handle`);
          await page.waitForTimeout(700);
          if (await waitForSliderResolution(page, 1200)) {
            return { ok: true, method: 'traditional_slider_refresh_clear', distance: 0 };
          }
          const det2 = await detectSlider(page);
          if (det2?.handle) det.handle = det2.handle;
          est = await estimateDistance(page, log);
          maxTravel = est.maxTravel;
          start = await getHandleStart(page, det);
          if (!start) continue;
        } else {
          log('handle mid-track but refresh budget exhausted — open-loop from current');
        }
      }

      const baseTarget =
        est.targetPiece != null && Number.isFinite(est.targetPiece)
          ? est.targetPiece
          : est.distance + (est.pieceLeft || 0);
      const target = Math.max(18, Math.min(maxTravel - 2, baseTarget + off));
      const puzzleKey = await readPuzzleKey(page);
      log(
        `attempt ${attempt} targetPiece=${target.toFixed(1)} (base=${Number(baseTarget).toFixed(1)} off=${off}) method=${est.method} gap=${est.gapLeftCss?.toFixed?.(1) ?? 'n/a'} refreshUsed=${refreshes}`
      );

      let dragResult;
      try {
        const pieceReadable = (await readPieceLeft(page)) != null;
        if (pieceReadable) {
          dragResult = await dragClosedLoop(page, start, target, maxTravel, log);
          // If grab failed, one open-loop retry on SAME puzzle (no refresh)
          if (dragResult?.noGrab || (dragResult?.moved != null && dragResult.moved < 8)) {
            log('no-grab → open-loop retry same puzzle');
            start = (await getHandleStart(page, det)) || start;
            // reset: if piece mid-way without refresh budget, just drag remaining
            const cur = (await readPieceLeft(page)) ?? 0;
            if (cur < 8) {
              dragResult = await dragFast(page, start, target, log);
            } else {
              // piece already moved some — nudge toward target open-loop
              const rem = Math.max(0, target - cur);
              if (rem > 3) {
                dragResult = await dragFast(page, start, rem, log);
              }
            }
          }
        } else {
          log('piece DOM unreadable → open-loop');
          dragResult = await dragFast(page, start, Math.max(18, target), log);
        }
      } catch (e) {
        log(`drag error: ${e.message}`);
        return { ok: false, error: e.message };
      }

      // Server acceptance can arrive seconds after the drag. Do not refresh or
      // retry while the successful Yoda request is still settling.
      if (await waitForSliderResolution(page, 5000)) {
        log(
          `SOLVED target=${target.toFixed(1)} piece=${dragResult?.piece?.toFixed?.(1) ?? 'n/a'} method=${est.method} refreshes=${refreshes}`
        );
        return {
          ok: true,
          method: 'traditional_slider_closed',
          distance: target,
          piece: dragResult?.piece,
          refreshes,
        };
      }

      log(
        `miss piece=${dragResult?.piece?.toFixed?.(1) ?? 'n/a'} target=${target.toFixed(1)} moved=${dragResult?.moved?.toFixed?.(1) ?? 'n/a'} samples=${dragResult?.samples ?? 0}`
      );
      const nextPuzzleKey = await readPuzzleKey(page);
      if (nextPuzzleKey && puzzleKey && nextPuzzleKey !== puzzleKey) {
        log(`puzzle rotated after miss ${puzzleKey.slice(0, 8)} → ${nextPuzzleKey.slice(0, 8)}; re-estimating`);
        est = await estimateDistance(page, log);
        maxTravel = est.maxTravel;
        forcedOffset = 0;
      }
      // brief pause between same-puzzle retries (no refresh)
      await page.waitForTimeout(200);
    }
  }

  return {
    ok: false,
    error: 'slider still present after traditional multi-try',
    distance: est.targetPiece ?? est.distance,
    refreshes,
  };
}
