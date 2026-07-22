import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { LONGCAT } from '../config.js';
import { collectFromSseBody, iterateSseLines, parseSseLine } from './sseParser.js';
import { accountCookieHeader } from '../db/index.js';
import { getProxyUrl } from './proxyPool.js';

function buildHeaders(cookie = '') {
  const h = {
    accept: 'text/event-stream,application/json',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'content-type': 'application/json',
    'm-appkey': LONGCAT.appkey,
    'm-traceid': String(Date.now()) + Math.floor(Math.random() * 1e6),
    origin: LONGCAT.base,
    referer: `${LONGCAT.base}/t`,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'x-client-language': 'zh',
    'x-requested-with': 'XMLHttpRequest',
  };
  if (cookie) h.cookie = cookie;
  return h;
}

function msgId() {
  return Math.floor(1e7 + Math.random() * 9e7);
}

export function buildOverseaPayload({ content, agentId = '1', reasonEnabled = 0, searchEnabled = 0 }) {
  const u = msgId();
  const a = msgId();
  return {
    content,
    agentId: String(agentId),
    messages: [
      {
        role: 'user',
        events: [{ type: 'userMsg', content, status: 'FINISHED' }],
        chatStatus: 'FINISHED',
        messageId: u,
        idType: 'custom',
      },
      {
        role: 'assistant',
        events: [],
        chatStatus: 'LOADING',
        messageId: a,
        idType: 'custom',
      },
    ],
    reasonEnabled: reasonEnabled ? 1 : 0,
    searchEnabled: searchEnabled ? 1 : 0,
    regenerate: 0,
  };
}

export function buildCnPayload({
  content,
  conversationId,
  agentId = '1',
  reasonEnabled = 0,
  searchEnabled = 0,
}) {
  return {
    content,
    conversationId,
    agentId: String(agentId),
    reasonEnabled: reasonEnabled ? 1 : 0,
    searchEnabled: searchEnabled ? 1 : 0,
    regenerate: 0,
    parentMessageId: 0,
    files: [],
  };
}

function dispatcherForProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    return new ProxyAgent(proxyUrl);
  } catch {
    return undefined;
  }
}

async function rawFetch(url, { method = 'POST', headers, body, proxyUrl, timeout = 180000 } = {}) {
  const dispatcher = dispatcherForProxy(proxyUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await undiciFetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      dispatcher,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create CN conversation session
 */
export async function createSession(account, { agentId = '1', proxyUrl } = {}) {
  const cookie = accountCookieHeader(account);
  const res = await rawFetch(LONGCAT.sessionCreate, {
    method: 'POST',
    headers: buildHeaders(cookie),
    body: { model: '', agentId: String(agentId) },
    proxyUrl,
    timeout: 60000,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`session-create invalid JSON HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  if (data.code !== 0) {
    throw new Error(`session-create failed: ${data.message || JSON.stringify(data)}`);
  }
  return data.data || {};
}

/**
 * Probe account validity
 */
export async function probeAccount(account, { proxyUrl } = {}) {
  const cookie = accountCookieHeader(account);
  if (!cookie) return { ok: false, detail: 'no cookie' };

  // prefer session-create (auth-sensitive)
  try {
    const data = await createSession(account, { proxyUrl });
    if (data.conversationId) {
      return { ok: true, detail: `session ok: ${String(data.conversationId).slice(0, 12)}...` };
    }
  } catch (e) {
    // fall through to user-current
    const err1 = e.message;
    try {
      const res = await rawFetch(LONGCAT.userCurrent, {
        method: 'GET',
        headers: buildHeaders(cookie),
        proxyUrl,
        timeout: 20000,
      });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `auth failed HTTP ${res.status}` };
      }
      try {
        const j = JSON.parse(text);
        if (j.code === 0 || j.data) {
          return { ok: true, detail: 'user-current ok' };
        }
        return { ok: false, detail: j.message || text.slice(0, 100) };
      } catch {
        if (res.status >= 200 && res.status < 300) {
          return { ok: true, detail: `HTTP ${res.status}` };
        }
        return { ok: false, detail: `HTTP ${res.status}: ${err1}` };
      }
    } catch (e2) {
      return { ok: false, detail: `${err1}; ${e2.message}` };
    }
  }
  return { ok: false, detail: 'unknown' };
}

/**
 * Chat completion (collect full body). Supports oversea & cn modes.
 */
export async function chatCollect({
  mode = 'oversea',
  account = null,
  content,
  agentId = '1',
  reasonEnabled = false,
  searchEnabled = false,
  useProxy = false,
}) {
  const proxyUrl = useProxy ? getProxyUrl() : null;
  const cookie = account ? accountCookieHeader(account) : '';

  let url;
  let payload;
  if (mode === 'cn') {
    if (!cookie) throw Object.assign(new Error('CN mode requires account cookie'), { status: 400 });
    const session = await createSession(account, { agentId, proxyUrl });
    const conversationId = session.conversationId;
    if (!conversationId) throw new Error('No conversationId from session-create');
    url = LONGCAT.cnV2;
    payload = buildCnPayload({
      content,
      conversationId,
      agentId,
      reasonEnabled,
      searchEnabled,
    });
  } else {
    url = LONGCAT.overseaV2;
    payload = buildOverseaPayload({
      content,
      agentId,
      reasonEnabled,
      searchEnabled,
    });
  }

  const maxRateRetries = 3;
  let lastErr = '';
  for (let attempt = 0; attempt <= maxRateRetries; attempt++) {
    const res = await rawFetch(url, {
      method: 'POST',
      headers: buildHeaders(cookie),
      body: payload,
      proxyUrl,
      timeout: 180000,
    });

    if (res.status === 401 || res.status === 403) {
      const err = new Error(`Upstream auth failed HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const bodyText = await res.text();

    // rate limit in body
    const trimmed = bodyText.trim();
    if (trimmed.startsWith('{')) {
      try {
        const j = JSON.parse(trimmed);
        if (j.code === 429 || res.status === 429) {
          lastErr = j.message || '429 rate limited';
          if (attempt < maxRateRetries) {
            await sleep(15000 * 2 ** attempt);
            continue;
          }
          const err = new Error(lastErr);
          err.status = 429;
          throw err;
        }
        if (j.code != null && j.code !== 0) {
          const err = new Error(`${j.code}: ${j.message || 'upstream error'}`);
          err.status = 502;
          throw err;
        }
      } catch (e) {
        if (e.status) throw e;
      }
    }

    if (res.status === 429) {
      if (attempt < maxRateRetries) {
        await sleep(15000 * 2 ** attempt);
        continue;
      }
      const err = new Error('429 rate limited');
      err.status = 429;
      throw err;
    }

    if (res.status !== 200) {
      const err = new Error(`Upstream HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      err.status = 502;
      throw err;
    }

    const collected = collectFromSseBody(bodyText, { thinkingEnabled: reasonEnabled });
    if (collected.error) {
      if (String(collected.error).includes('429') && attempt < maxRateRetries) {
        await sleep(15000 * 2 ** attempt);
        continue;
      }
      const err = new Error(collected.error);
      err.status = String(collected.error).includes('429') ? 429 : 502;
      throw err;
    }
    return collected;
  }
  const err = new Error(lastErr || 'chat failed');
  err.status = 502;
  throw err;
}

/**
 * Stream chat → async generator of parsed SSE results + raw openAI-ready deltas
 */
export async function* chatStream({
  mode = 'oversea',
  account = null,
  content,
  agentId = '1',
  reasonEnabled = false,
  searchEnabled = false,
  useProxy = false,
}) {
  const proxyUrl = useProxy ? getProxyUrl() : null;
  const cookie = account ? accountCookieHeader(account) : '';

  let url;
  let payload;
  if (mode === 'cn') {
    if (!cookie) throw Object.assign(new Error('CN mode requires account cookie'), { status: 400 });
    const session = await createSession(account, { agentId, proxyUrl });
    const conversationId = session.conversationId;
    if (!conversationId) throw new Error('No conversationId');
    url = LONGCAT.cnV2;
    payload = buildCnPayload({
      content,
      conversationId,
      agentId,
      reasonEnabled,
      searchEnabled,
    });
  } else {
    url = LONGCAT.overseaV2;
    payload = buildOverseaPayload({
      content,
      agentId,
      reasonEnabled,
      searchEnabled,
    });
  }

  const res = await rawFetch(url, {
    method: 'POST',
    headers: buildHeaders(cookie),
    body: payload,
    proxyUrl,
    timeout: 180000,
  });

  if (res.status === 401 || res.status === 403) {
    const err = new Error(`Upstream auth failed HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  // Some oversea responses buffer whole body; still iterate
  let bufferPeek = '';
  const reader = res.body;
  if (!reader) {
    const text = await res.text();
    yield* drainBodyAsEvents(text, reasonEnabled);
    return;
  }

  // Peek first chunk for JSON error
  const decoder = new TextDecoder('utf-8');
  let lineBuf = '';
  let first = true;
  for await (const chunk of reader) {
    const s = decoder.decode(chunk, { stream: true });
    if (first) {
      first = false;
      bufferPeek = s;
      const trimmed = bufferPeek.trim();
      if (trimmed.startsWith('{') && !trimmed.includes('data:')) {
        try {
          const j = JSON.parse(trimmed);
          if (j.code != null && j.code !== 0) {
            const err = new Error(`${j.code}: ${j.message || 'error'}`);
            err.status = j.code === 429 ? 429 : 502;
            throw err;
          }
        } catch (e) {
          if (e.status) throw e;
        }
      }
    }
    lineBuf += s;
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() || '';
    for (const line of lines) {
      const parsed = parseSseLine(line);
      if (parsed.valid) yield parsed;
    }
  }
  if (lineBuf.trim()) {
    const parsed = parseSseLine(lineBuf);
    if (parsed.valid) yield parsed;
  }
}

function* drainBodyAsEvents(bodyText, reasonEnabled) {
  for (const line of String(bodyText).split('\n')) {
    const parsed = parseSseLine(line);
    if (parsed.valid) yield parsed;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { buildHeaders, rawFetch };
