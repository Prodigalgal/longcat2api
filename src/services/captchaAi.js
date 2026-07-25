/**
 * AI vision captcha helper (OpenAI-compatible chat/completions).
 * Same idea as MiMo2API captcha_ai — **last-resort fallback only**.
 * Config via config.json / env; never hardcode secrets.
 */

import { config } from '../config.js';

const PROMPT_IMAGE =
  '这是登录/注册页面的验证码图片（可能是扭曲字母数字、简单中文或图形字符）。' +
  '请只输出验证码字符本身，不要空格、不要引号、不要解释。' +
  '若看不清，尽量猜测最可能的 3-8 个字符。';

const PROMPT_SLIDER =
  '这是滑块/拼图验证码截图。请用一句话说明滑块应向右拖动的大致比例，' +
  '格式严格为：RATIO=0.xx （0~1 之间小数）。不要其他文字。';

export function getCaptchaAiConfig() {
  const ca = config.getCaptchaAi?.() || config.get().captcha_ai || {};
  const n = {
    enabled: !!ca.enabled,
    api_base: String(ca.api_base || '').replace(/\/+$/, ''),
    api_key: String(ca.api_key || ''),
    model: String(ca.model || 'grok-4.5').trim() || 'grok-4.5',
    timeout: Math.max(15, Math.min(180, Number(ca.timeout) || 90)),
  };
  n.ready = !!(n.enabled && n.api_base && n.api_key);
  return n;
}

function cleanCode(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t.split(/\r?\n/)[0].trim();
  t = t.replace(/^[`"'\\\s]+|[`"'\\\s]+$/g, '');
  t = t.replace(/[^\w\u4e00-\u9fff]/g, '');
  return t;
}

function parseRatio(text) {
  const m = String(text || '').match(/RATIO\s*=\s*(0?\.\d+|1(?:\.0+)?|\d+(?:\.\d+)?)/i);
  if (m) {
    let r = Number(m[1]);
    if (r > 1 && r <= 100) r = r / 100;
    if (r >= 0 && r <= 1) return r;
  }
  const m2 = String(text || '').match(/(0\.\d+)/);
  if (m2) {
    const r = Number(m2[1]);
    if (r >= 0 && r <= 1) return r;
  }
  return null;
}

/**
 * @param {Buffer|Uint8Array} imageBytes
 * @param {{ kind?: 'image'|'slider', contentType?: string }} opts
 * @returns {Promise<{ ok: boolean, code?: string, ratio?: number, raw?: string, error?: string }>}
 */
/**
 * Yoda sudoku / connect-the-dots: return click points as [xRatio,yRatio] list.
 * Prompt asks for POINTS=0.12,0.34;0.55,0.66 format.
 */
export async function solveYodaSudokuWithAi(imageBytes) {
  const cfg = getCaptchaAiConfig();
  if (!cfg.ready) return { ok: false, error: 'captcha_ai not configured' };
  if (!imageBytes?.length) return { ok: false, error: 'empty image' };

  const b64 = Buffer.from(imageBytes).toString('base64');
  const dataUrl = `data:image/png;base64,${b64}`;
  const prompt =
    '这是美团/Keeta Yoda 人机验证截图。可能类型：\n' +
    'A) Tap icons in following order：顶部有一排要按顺序点的小图标，下方是图标网格。\n' +
    'B) Connect the dots / shortest line：连接棕色圆点。\n' +
    'C) Move the slider：拼图滑块（若是滑块请输出 POINTS=0.5,0.5 即可）。\n' +
    '任务：根据标题与图案，输出要点击/经过的中心坐标（相对本截图宽高 0~1，左上为0,0）。\n' +
    '点选题：按「标题要求的顺序」依次给出每个目标图标中心（通常 3~5 个）。\n' +
    '连线题：给出路径上 3~6 个控制点。\n' +
    '严格只输出一行：POINTS=x1,y1;x2,y2;x3,y3\n' +
    '示例 POINTS=0.20,0.18;0.45,0.55;0.72,0.40 不要其他文字。';

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeout * 1000);
    let res;
    try {
      res = await fetch(`${cfg.api_base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 120,
          temperature: 0,
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, raw: text.slice(0, 200) };
    const data = JSON.parse(text);
    let content = data?.choices?.[0]?.message?.content || '';
    if (Array.isArray(content)) {
      content = content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }
    content = String(content || '');
    console.log(`[CaptchaAI] sudoku raw=${JSON.stringify(content).slice(0, 200)}`);
    const m = content.match(/POINTS\s*=\s*([0-9.,;\s]+)/i);
    if (!m) return { ok: false, error: 'no POINTS in reply', raw: content };
    const points = [];
    for (const part of m[1].split(';')) {
      const nums = part.split(',').map((x) => Number(String(x).trim()));
      if (nums.length >= 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
        points.push([nums[0], nums[1]]);
      }
    }
    if (!points.length) return { ok: false, error: 'empty points', raw: content };
    return { ok: true, points, raw: content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function solveCaptchaWithAi(imageBytes, opts = {}) {
  const cfg = getCaptchaAiConfig();
  if (!cfg.ready) {
    return { ok: false, error: 'captcha_ai not configured/enabled' };
  }
  if (!imageBytes || !imageBytes.length) {
    return { ok: false, error: 'empty image' };
  }

  const kind = opts.kind === 'slider' ? 'slider' : 'image';
  const mime = (opts.contentType || 'image/png').startsWith('image/')
    ? opts.contentType || 'image/png'
    : 'image/png';
  const b64 = Buffer.from(imageBytes).toString('base64');
  const dataUrl = `data:${mime};base64,${b64}`;
  const url = `${cfg.api_base}/v1/chat/completions`;
  const prompt = kind === 'slider' ? PROMPT_SLIDER : PROMPT_IMAGE;

  const payload = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: kind === 'slider' ? 64 : 32,
    temperature: 0,
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeout * 1000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      console.warn(`[CaptchaAI] HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${res.status}`, raw: text.slice(0, 200) };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: 'invalid JSON response' };
    }
    let content = data?.choices?.[0]?.message?.content || '';
    if (Array.isArray(content)) {
      content = content
        .map((p) => (typeof p === 'string' ? p : p?.text || ''))
        .join('');
    }
    content = String(content || '');
    console.log(`[CaptchaAI] model=${cfg.model} kind=${kind} raw=${JSON.stringify(content).slice(0, 120)}`);

    if (kind === 'slider') {
      const ratio = parseRatio(content);
      if (ratio == null) return { ok: false, error: 'no ratio in AI reply', raw: content };
      return { ok: true, ratio, raw: content };
    }
    const code = cleanCode(content);
    if (!code) return { ok: false, error: 'empty code', raw: content };
    return { ok: true, code, raw: content };
  } catch (e) {
    console.warn(`[CaptchaAI] failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}
