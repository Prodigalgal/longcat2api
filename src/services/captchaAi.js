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
    model: String(ca.model || 'grok').trim() || 'grok',
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
    '这是美团/Keeta Yoda 验证码截图（连线/点选/九宫格）。' +
    '请根据英文提示（如 Use the shortest line to connect the dots in brown / Tap icons in following order）' +
    '给出应点击的顺序坐标，坐标为相对整张截图的比例 0~1。' +
    '严格只输出一行：POINTS=x1,y1;x2,y2;x3,y3 例如 POINTS=0.20,0.45;0.50,0.45;0.80,0.45' +
    '不要其他文字。';

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
