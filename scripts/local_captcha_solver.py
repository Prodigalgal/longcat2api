#!/usr/bin/env python3
"""Local captcha solvers for LongCat/Mykeeta Yoda (no cloud AI).

Backends (same stack as qwen2api):
  - ddddocr slide_match          https://github.com/sml2h3/ddddocr
  - captcha-recognizer Slider    https://github.com/chenwei-zhao/captcha-recognizer
  - OpenCV Canny template match / color dots / icon template match

CLI (stdout = JSON only):
  python scripts/local_captcha_solver.py slider --bg bg.png --piece piece.png
  python scripts/local_captcha_solver.py slider --bg-b64 ... --piece-b64 ...
  python scripts/local_captcha_solver.py dots --image canvas.png --color yellow
  python scripts/local_captcha_solver.py tap --targets targets.png --panel panel.png
  python scripts/local_captcha_solver.py health
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# lazy heavy deps
# ---------------------------------------------------------------------------

def _cv2():
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    return cv2, np


def _decode_image(data: bytes):
    cv2, np = _cv2()
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("opencv imdecode failed")
    return img


def _piece_geometry(bg_img, piece_img):
    """Extract the visible jigsaw from Yoda's tall moving strip.

    The DOM element is roughly 93x222, while the actual jigsaw occupies only a
    small area inside it.  Element screenshots are composited over the same
    background, so their pixel delta gives us both the real piece template and
    its home offset inside the moving strip.
    """
    cv2, np = _cv2()

    def bgr(im):
        if im.ndim == 2:
            return cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
        if im.shape[2] == 4:
            return cv2.cvtColor(im, cv2.COLOR_BGRA2BGR)
        return im[:, :, :3]

    bg_bgr = bgr(bg_img)
    pc_bgr = bgr(piece_img)
    h = min(bg_bgr.shape[0], pc_bgr.shape[0])
    w = min(bg_bgr.shape[1], pc_bgr.shape[1])
    if h < 30 or w < 20:
        return None

    delta = cv2.absdiff(pc_bgr[:h, :w], bg_bgr[:h, :w])
    mag = delta.max(axis=2)
    mask = (mag >= 16).astype("uint8") * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

    # Ignore single-pixel antialiasing noise and retain columns/rows carrying a
    # meaningful part of the piece.
    xs = np.where((mask > 0).sum(axis=0) >= max(3, int(h * 0.025)))[0]
    ys = np.where((mask > 0).sum(axis=1) >= max(3, int(w * 0.04)))[0]
    if len(xs) < 12 or len(ys) < 12:
        return None

    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    visual_w = x1 - x0
    visual_h = y1 - y0
    if visual_w < 12 or visual_w > int(w * 0.9) or visual_h < 12 or visual_h > int(h * 0.75):
        return None

    crop = pc_bgr[y0:y1, x0:x1]
    alpha = mask[y0:y1, x0:x1]
    rgba = cv2.cvtColor(crop, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = alpha
    ok, encoded = cv2.imencode(".png", rgba)
    if not ok:
        return None
    return {
        "offset_x": x0,
        "offset_y": y0,
        "visual_width": visual_w,
        "visual_height": visual_h,
        "piece_png": encoded.tobytes(),
    }


def _read_input(path: Optional[str], b64: Optional[str]) -> bytes:
    if b64:
        raw = b64.strip()
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[-1]
        return base64.b64decode(raw)
    if path:
        return Path(path).read_bytes()
    raise ValueError("need --path or --b64")


def out(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------

def cmd_health(_: argparse.Namespace) -> None:
    """Lightweight import check only — do NOT instantiate heavy YOLO/ONNX models.
    Instantiating captcha-recognizer Slider() loads a large model and can OOM
    Camoufox if health runs mid-registration.
    """
    info: Dict[str, Any] = {"ok": True, "backends": {}}
    try:
        import ddddocr  # type: ignore

        info["backends"]["ddddocr"] = {
            "ok": True,
            "slide_match": hasattr(ddddocr.DdddOcr, "slide_match"),
        }
    except Exception as exc:
        info["backends"]["ddddocr"] = {"ok": False, "error": str(exc)}
    try:
        import captcha_recognizer  # type: ignore  # noqa: F401
        from captcha_recognizer.slider import Slider  # type: ignore  # noqa: F401

        info["backends"]["captcha_recognizer"] = {"ok": True, "lazy": True}
    except Exception as exc:
        info["backends"]["captcha_recognizer"] = {"ok": False, "error": str(exc)}
    try:
        cv2, _ = _cv2()
        info["backends"]["opencv"] = {"ok": True, "version": cv2.__version__}
    except Exception as exc:
        info["backends"]["opencv"] = {"ok": False, "error": str(exc)}
        info["ok"] = False
    out(info)


# ---------------------------------------------------------------------------
# slider gap
# ---------------------------------------------------------------------------

def _ddddocr_gap(bg: bytes, piece: bytes) -> Tuple[int, float, str]:
    import ddddocr  # type: ignore

    eng = ddddocr.DdddOcr(det=False, ocr=False, show_ad=False)
    last: Optional[Exception] = None
    for simple in (False, True):
        try:
            res = eng.slide_match(piece, bg, simple_target=simple)
            gap = int(res["target"][0])
            if gap < 12:
                raise ValueError(f"implausible gap={gap}")
            conf = 0.88 if not simple else 0.72
            return gap, conf, f"ddddocr simple={simple} box={res['target']}"
        except Exception as exc:
            last = exc
    raise RuntimeError(f"ddddocr failed: {last}")


def _recognizer_gap(bg: bytes) -> Tuple[int, float, str]:
    from captcha_recognizer.slider import Slider  # type: ignore

    slider = Slider()
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        f.write(bg)
        tmp = Path(f.name)
    try:
        box, confidence = slider.identify(source=str(tmp), show=False)
        gap = int(round(float(box[0])))
        conf = float(confidence)
        if gap < 12:
            raise ValueError(f"implausible gap={gap}")
        return gap, conf, f"recognizer box={box} conf={conf:.3f}"
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass


def _opencv_gap(bg: bytes, piece: bytes) -> Tuple[int, float, str]:
    cv2, np = _cv2()
    bg_img = _decode_image(bg)
    pc_img = _decode_image(piece)

    def to_gray(im):
        if im.ndim == 2:
            return im
        if im.shape[2] == 4:
            return cv2.cvtColor(im, cv2.COLOR_BGRA2GRAY)
        return cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)

    bg_gray = to_gray(bg_img)
    alpha = None
    if pc_img.ndim == 3 and pc_img.shape[2] == 4:
        alpha = pc_img[:, :, 3]
        pc_gray = cv2.cvtColor(pc_img, cv2.COLOR_BGRA2GRAY)
        ys, xs = np.where(alpha > 20)
        if len(xs) > 50:
            y0, y1 = int(ys.min()), int(ys.max()) + 1
            x0, x1 = int(xs.min()), int(xs.max()) + 1
            pc_gray = pc_gray[y0:y1, x0:x1]
            alpha = alpha[y0:y1, x0:x1]
    else:
        pc_gray = to_gray(pc_img)

    bg_e = cv2.Canny(bg_gray, 80, 180)
    pc_e = cv2.Canny(pc_gray, 80, 180)
    if alpha is not None:
        pc_e = cv2.bitwise_and(pc_e, pc_e, mask=(alpha > 20).astype("uint8") * 255)
    if pc_e.shape[0] >= bg_e.shape[0] or pc_e.shape[1] >= bg_e.shape[1]:
        raise RuntimeError("piece larger than background")
    res = cv2.matchTemplate(bg_e, pc_e, cv2.TM_CCOEFF_NORMED)
    # zero out home strip AND right frame (false peaks)
    x_cut = max(16, int(bg_e.shape[1] * 0.15), int(pc_e.shape[1] * 0.5))
    res[:, :x_cut] = -1.0
    right_cut = max(x_cut + 8, int(bg_e.shape[1] * 0.82) - pc_e.shape[1])
    if right_cut < res.shape[1]:
        res[:, right_cut:] = -1.0
    _min_v, max_v, _min_l, max_l = cv2.minMaxLoc(res)
    gap = int(max_l[0])
    conf = 0.45 + 0.45 * float(max(0.0, min(1.0, max_v)))
    if gap < 12:
        raise ValueError(f"implausible gap={gap}")
    return gap, conf, f"opencv score={max_v:.3f}"


def _fuse(estimates: List[Tuple[str, int, float]], radius: float = 18.0) -> Tuple[int, float, List[str]]:
    if not estimates:
        raise RuntimeError("no estimates")
    if len(estimates) == 1:
        n, gx, w = estimates[0]
        return gx, w, [n]

    best_score = -1.0
    best_cluster: List[Tuple[str, int, float]] = []
    for _n, seed, _w in estimates:
        cluster = [(n, x, w) for n, x, w in estimates if abs(x - seed) <= radius]
        score = sum(w for _, _, w in cluster) * (1.0 + 0.15 * len(cluster))
        if score > best_score:
            best_score = score
            best_cluster = cluster
    wsum = sum(w for _, _, w in best_cluster) or 1.0
    gx = int(round(sum(x * w for _, x, w in best_cluster) / wsum))
    conf = min(0.99, wsum / (wsum + 0.8))
    return gx, conf, [n for n, _, _ in best_cluster]


def _plausible_gap(gap: int, w: int, piece_w: int = 0) -> bool:
    """Reject home-zone / right-frame false peaks that caused drag≈212 misses."""
    if gap < 12:
        return False
    # hole never sits under the home piece strip
    left_min = max(int(w * 0.18), int(piece_w * 0.55) if piece_w else int(w * 0.18))
    if gap < left_min:
        return False
    # right frame / border often steals max edge score
    if gap > int(w * 0.78):
        return False
    return True


def cmd_slider(args: argparse.Namespace) -> None:
    bg = _read_input(args.bg, args.bg_b64)
    piece = _read_input(args.piece, args.piece_b64) if (args.piece or args.piece_b64) else None
    estimates: List[Tuple[str, int, float]] = []
    errors: List[str] = []

    bg_img = _decode_image(bg)
    h, w = bg_img.shape[:2]
    piece_w = 0
    piece_offset_x = 0
    piece_geometry = None
    if piece:
        try:
            pc = _decode_image(piece)
            piece_geometry = _piece_geometry(bg_img, pc)
            if piece_geometry:
                piece = piece_geometry["piece_png"]
                piece_w = int(piece_geometry["visual_width"])
                piece_offset_x = int(piece_geometry["offset_x"])
            else:
                piece_w = int(pc.shape[1])
        except Exception:
            piece_w = 0

    if piece:
        try:
            gx, cf, det = _ddddocr_gap(bg, piece)
            if _plausible_gap(gx, w, piece_w):
                estimates.append(("ddddocr", gx, cf))
                errors.append(det)
            else:
                errors.append(f"ddddocr rejected gap={gx}/{w}")
        except Exception as exc:
            errors.append(f"ddddocr: {exc}")
        try:
            gx, cf, det = _opencv_gap(bg, piece)
            if _plausible_gap(gx, w, piece_w):
                estimates.append(("opencv", gx, cf * 0.9))
                errors.append(det)
            else:
                errors.append(f"opencv rejected gap={gx}/{w}")
        except Exception as exc:
            errors.append(f"opencv: {exc}")

    try:
        gx, cf, det = _recognizer_gap(bg)
        if _plausible_gap(gx, w, piece_w):
            estimates.append(("recognizer", gx, cf * 1.1))
            errors.append(det)
        else:
            errors.append(f"recognizer rejected gap={gx}/{w}")
    except Exception as exc:
        errors.append(f"recognizer: {exc}")

    # Always try clean-bg edge scan (helps fuse / fallback). Prefer when no piece match.
    try:
        gx, cf, det = _bg_only_edge_gap(bg, piece_w=piece_w)
        if _plausible_gap(gx, w, piece_w):
            # lower weight if we already have template matches
            weight = cf * (0.55 if estimates else 1.0)
            estimates.append(("edge", gx, weight))
            errors.append(det)
        else:
            errors.append(f"edge rejected gap={gx}/{w}")
    except Exception as exc:
        errors.append(f"edge: {exc}")

    if not estimates:
        out({"ok": False, "error": "; ".join(errors), "natural_width": int(w)})
        return

    gap, conf, members = _fuse(estimates)
    if not _plausible_gap(gap, w, piece_w):
        # fall back to best individual estimate that is plausible
        ok_ests = [(n, x, wt) for n, x, wt in estimates if _plausible_gap(x, w, piece_w)]
        if not ok_ests:
            out({"ok": False, "error": f"all gaps implausible; {'; '.join(errors)}", "natural_width": int(w)})
            return
        gap, conf, members = _fuse(ok_ests)

    out(
        {
            "ok": True,
            "kind": "slider",
            "gap_x": gap,
            "confidence": conf,
            "natural_width": int(w),
            "natural_height": int(h),
            "piece_offset_x": piece_offset_x,
            "piece_visual_width": piece_w,
            "piece_geometry_detected": bool(piece_geometry),
            "methods": members,
            "detail": errors,
        }
    )


def _bg_only_edge_gap(bg: bytes, piece_w: int = 0) -> Tuple[int, float, str]:
    """Find hole LEFT edge on clean background (piece should already be hidden).

    Sliding window of width ≈ piece: score = dark interior + left rim + right rim.
    Avoids picking the hole's RIGHT rim alone (old max-edge → gap≈213 vs true ~204).
    """
    cv2, np = _cv2()
    im = _decode_image(bg)
    if im.ndim == 3 and im.shape[2] == 4:
        gray = cv2.cvtColor(im, cv2.COLOR_BGRA2GRAY)
    elif im.ndim == 3:
        gray = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    else:
        gray = im

    h, w = gray.shape
    pw = int(piece_w) if piece_w and piece_w > 20 else max(40, int(w * 0.30))
    pw = min(pw, int(w * 0.48))
    y0, y1 = int(h * 0.15), int(h * 0.85)
    roi = gray[y0:y1, :]
    edges = cv2.Canny(roi, 50, 150)

    lum = roi.mean(axis=0).astype(np.float64)
    edge_col = edges.sum(axis=0).astype(np.float64)
    k = np.array([0.1, 0.2, 0.4, 0.2, 0.1], dtype=np.float64)
    edge_s = np.convolve(edge_col, k, mode="same")
    g_lum = float(lum.mean()) if lum.size else 128.0

    x_left_min = max(int(w * 0.16), int(pw * 0.35))
    x_left_max = min(int(w * 0.72), w - pw - 4)

    best_left = (x_left_min + x_left_max) // 2
    best_score = -1e18
    best_detail = ""
    for left in range(x_left_min, x_left_max + 1):
        right = left + pw
        mid0 = left + int(pw * 0.2)
        mid1 = left + int(pw * 0.8)
        interior = float(lum[mid0:mid1].mean()) if mid1 > mid0 else g_lum
        dark = max(0.0, g_lum - interior)
        left_edge = float(edge_s[max(0, left - 2) : min(w, left + 4)].max()) if w else 0.0
        right_edge = float(edge_s[max(0, right - 3) : min(w, right + 3)].max()) if w else 0.0
        # skip classic false hit: only right rim is strong
        if left_edge < right_edge * 0.35 and left_edge < 80:
            continue
        pos_bias = 1.0 - 0.12 * ((left - x_left_min) / max(1, x_left_max - x_left_min))
        score = (
            dark * 3.0
            + left_edge * 1.4
            + right_edge * 0.7
            + min(left_edge, right_edge) * 0.8
        ) * pos_bias
        if score > best_score:
            best_score = score
            best_left = left
            best_detail = f"dark={dark:.1f} Le={left_edge:.0f} Re={right_edge:.0f}"

    # snap to strongest edge peak near the chosen left rim
    refined = best_left
    peak = float(edge_s[best_left]) if best_left < w else 0.0
    lo = max(x_left_min, best_left - 6)
    hi = min(x_left_max, best_left + 4)
    for x in range(lo, hi + 1):
        if float(edge_s[x]) > peak:
            peak = float(edge_s[x])
            refined = x

    conf = 0.62 if best_score > 0 else 0.35
    return (
        int(refined),
        conf,
        f"edge window left={refined} pw={pw} score={best_score:.1f} {best_detail} band={x_left_min}-{x_left_max}",
    )


# ---------------------------------------------------------------------------
# connect-the-dots (colored blobs)
# ---------------------------------------------------------------------------

_COLOR_RANGES = {
    # HSV ranges (OpenCV H:0-180)
    "yellow": [(20, 80, 80), (40, 255, 255)],
    "green": [(35, 50, 50), (90, 255, 255)],
    "orange": [(5, 80, 80), (25, 255, 255)],
    "purple": [(120, 40, 40), (160, 255, 255)],
    "blue": [(90, 50, 50), (130, 255, 255)],
    "red": [(0, 80, 80), (10, 255, 255)],  # also wrap handled below
}


def cmd_dots(args: argparse.Namespace) -> None:
    cv2, np = _cv2()
    data = _read_input(args.image, args.image_b64)
    im = _decode_image(data)
    if im.ndim == 2:
        bgr = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
    elif im.shape[2] == 4:
        bgr = cv2.cvtColor(im, cv2.COLOR_BGRA2BGR)
    else:
        bgr = im
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, w = bgr.shape[:2]
    color = (args.color or "any").lower()

    mask = None
    if color in _COLOR_RANGES:
        lo, hi = _COLOR_RANGES[color]
        mask = cv2.inRange(hsv, np.array(lo), np.array(hi))
        if color == "red":
            mask2 = cv2.inRange(hsv, np.array([170, 80, 80]), np.array([180, 255, 255]))
            mask = cv2.bitwise_or(mask, mask2)
    else:
        # saturated blobs of any hue
        mask = cv2.inRange(hsv, np.array([0, 60, 60]), np.array([180, 255, 255]))

    mask = cv2.medianBlur(mask, 5)
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    dots: List[Tuple[float, float, float]] = []
    min_area = max(20, (w * h) * 0.0003)
    max_area = (w * h) * 0.08
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area or area > max_area:
            continue
        m = cv2.moments(c)
        if m["m00"] == 0:
            continue
        cx = m["m10"] / m["m00"]
        cy = m["m01"] / m["m00"]
        dots.append((cx / w, cy / h, area))

    if len(dots) < 2:
        out({"ok": False, "error": f"found {len(dots)} dots color={color}", "kind": "dots"})
        return

    # nearest-neighbor path
    pts = [(x, y) for x, y, _a in sorted(dots, key=lambda t: -t[2])[:12]]
    ordered = [pts[0]]
    left = pts[1:]
    while left:
        lx, ly = ordered[-1]
        bi, bd = 0, 1e9
        for i, (x, y) in enumerate(left):
            d = (x - lx) ** 2 + (y - ly) ** 2
            if d < bd:
                bd, bi = d, i
        ordered.append(left.pop(bi))

    out(
        {
            "ok": True,
            "kind": "dots",
            "color": color,
            "points": [[round(x, 4), round(y, 4)] for x, y in ordered],
            "count": len(ordered),
        }
    )


# ---------------------------------------------------------------------------
# tap icons: match ordered targets (top strip) into panel grid
# ---------------------------------------------------------------------------

def cmd_tap(args: argparse.Namespace) -> None:
    cv2, np = _cv2()
    targets = _decode_image(_read_input(args.targets, args.targets_b64))
    panel = _decode_image(_read_input(args.panel, args.panel_b64))

    def to_bgr(im):
        if im.ndim == 2:
            return cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
        if im.shape[2] == 4:
            return cv2.cvtColor(im, cv2.COLOR_BGRA2BGR)
        return im

    targets = to_bgr(targets)
    panel = to_bgr(panel)
    th, tw = targets.shape[:2]
    ph, pw = panel.shape[:2]

    # Split target strip into icon cells by vertical projection of non-white content
    gray_t = cv2.cvtColor(targets, cv2.COLOR_BGR2GRAY)
    # ink = darker than background
    ink = gray_t < 240
    col_sum = ink.sum(axis=0)
    # find runs of content columns
    cells: List[Tuple[int, int]] = []
    in_run = False
    start = 0
    thresh = max(1, int(th * 0.08))
    for x, v in enumerate(col_sum):
        if v >= thresh and not in_run:
            in_run = True
            start = x
        elif v < thresh and in_run:
            in_run = False
            if x - start >= 8:
                cells.append((start, x))
    if in_run and tw - start >= 8:
        cells.append((start, tw))

    # merge tiny gaps
    merged: List[List[int]] = []
    for a, b in cells:
        if merged and a - merged[-1][1] < 6:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    cells = [(a, b) for a, b in merged if b - a >= 10]

    if len(cells) < 2:
        # equal split fallback (3-5 icons common)
        n = int(args.n_targets or 4)
        step = tw / n
        cells = [(int(i * step), int((i + 1) * step)) for i in range(n)]

    # crop each target icon (trim vertical padding)
    icons: List[Any] = []
    for a, b in cells:
        crop = targets[:, max(0, a - 1) : min(tw, b + 1)]
        g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        rows = (g < 240).sum(axis=1)
        ys = np.where(rows >= max(1, int((b - a) * 0.05)))[0]
        if len(ys) > 2:
            crop = crop[max(0, ys[0] - 1) : min(th, ys[-1] + 2), :]
        if crop.shape[0] < 8 or crop.shape[1] < 8:
            continue
        icons.append(crop)

    if not icons:
        out({"ok": False, "error": "no target icons segmented", "kind": "tap"})
        return

    panel_gray = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)
    panel_edge = cv2.Canny(panel_gray, 50, 150)

    points: List[List[float]] = []
    scores: List[float] = []
    used_boxes: List[Tuple[int, int, int, int]] = []

    for icon in icons:
        ih, iw = icon.shape[:2]
        # try a few scales relative to panel
        best = None  # (score, cx, cy, x, y, w, h)
        for scale in (0.9, 1.0, 1.1, 1.25, 0.75, 1.4):
            nw, nh = max(8, int(iw * scale)), max(8, int(ih * scale))
            if nh >= ph or nw >= pw:
                continue
            templ = cv2.resize(icon, (nw, nh), interpolation=cv2.INTER_AREA)
            t_gray = cv2.cvtColor(templ, cv2.COLOR_BGR2GRAY)
            t_edge = cv2.Canny(t_gray, 50, 150)
            # match on edges + grayscale
            try:
                r1 = cv2.matchTemplate(panel_edge, t_edge, cv2.TM_CCOEFF_NORMED)
                r2 = cv2.matchTemplate(panel_gray, t_gray, cv2.TM_CCOEFF_NORMED)
            except Exception:
                continue
            r = 0.55 * r1 + 0.45 * r2
            # suppress already used regions
            for ux, uy, uw, uh in used_boxes:
                x0 = max(0, ux - nw // 3)
                y0 = max(0, uy - nh // 3)
                x1 = min(r.shape[1], ux + uw)
                y1 = min(r.shape[0], uy + uh)
                r[y0:y1, x0:x1] = -1.0
            _min_v, max_v, _min_l, max_l = cv2.minMaxLoc(r)
            if best is None or max_v > best[0]:
                mx, my = max_l
                best = (float(max_v), mx + nw / 2, my + nh / 2, mx, my, nw, nh)
        if best is None or best[0] < 0.25:
            # weak match — skip but keep slot? better skip
            continue
        score, cx, cy, mx, my, nw, nh = best
        used_boxes.append((mx, my, nw, nh))
        points.append([round(cx / pw, 4), round(cy / ph, 4)])
        scores.append(score)

    if len(points) < 2:
        out(
            {
                "ok": False,
                "error": f"matched only {len(points)} icons",
                "kind": "tap",
                "n_targets": len(icons),
            }
        )
        return

    out(
        {
            "ok": True,
            "kind": "tap",
            "points": points,
            "scores": [round(s, 3) for s in scores],
            "n_targets": len(icons),
            "confidence": float(sum(scores) / max(1, len(scores))),
        }
    )


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_h = sub.add_parser("health")
    p_h.set_defaults(func=cmd_health)

    p_s = sub.add_parser("slider")
    p_s.add_argument("--bg")
    p_s.add_argument("--bg-b64")
    p_s.add_argument("--piece")
    p_s.add_argument("--piece-b64")
    p_s.set_defaults(func=cmd_slider)

    p_d = sub.add_parser("dots")
    p_d.add_argument("--image")
    p_d.add_argument("--image-b64")
    p_d.add_argument("--color", default="any")
    p_d.set_defaults(func=cmd_dots)

    p_t = sub.add_parser("tap")
    p_t.add_argument("--targets")
    p_t.add_argument("--targets-b64")
    p_t.add_argument("--panel")
    p_t.add_argument("--panel-b64")
    p_t.add_argument("--n-targets", type=int, default=0)
    p_t.set_defaults(func=cmd_tap)

    args = ap.parse_args()
    try:
        args.func(args)
    except Exception as exc:
        out({"ok": False, "error": str(exc)})
        sys.exit(0)  # still emit JSON


if __name__ == "__main__":
    main()
