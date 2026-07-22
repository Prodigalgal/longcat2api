/**
 * LongCat SSE parser (oversea-V2 / chat-completion-V2)
 * Format: data: {"event":{"type":"content|reason|think|finish",...},"lastOne":false,...}
 */

export function parseSseLine(raw) {
  const line = String(raw || '').trim();
  if (!line || line.startsWith(':') || line.startsWith('event:')) {
    return { valid: false };
  }
  if (!line.startsWith('data:')) {
    // bare JSON error body
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line);
        if (j.code != null && j.code !== 0) {
          return {
            valid: true,
            stop: true,
            error: `${j.code}: ${j.message || 'Unknown error'}`,
            usage: {},
          };
        }
      } catch {
        /* ignore */
      }
    }
    return { valid: false };
  }
  const dataStr = line.slice(5).trim();
  if (dataStr === '[DONE]') {
    return { valid: true, stop: true, done: true };
  }
  try {
    const chunk = JSON.parse(dataStr);
    return parseChunk(chunk);
  } catch {
    return { valid: false };
  }
}

function parseChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return { valid: false };

  if (chunk.code != null && chunk.code !== 0) {
    return {
      valid: true,
      stop: true,
      error: `${chunk.code}: ${chunk.message || 'Unknown error'}`,
      usage: {},
    };
  }

  const event = chunk.event || {};
  const eventType = event.type || '';
  const result = {
    valid: true,
    stop: false,
    eventType,
    conversationId: chunk.conversationId || '',
    messageId: chunk.messageId || 0,
    model: chunk.model || '',
    lastOne: !!chunk.lastOne,
    text: '',
    thinking: '',
    finalContent: '',
    contentFilter: false,
    usage: {},
  };

  // Legacy cumulative content (old chat-completion)
  if (chunk.content && typeof chunk.content === 'string' && !eventType) {
    result.text = chunk.content;
    result.cumulative = true;
    if (chunk.lastOne || chunk.contentStatus === 'FINISHED') {
      result.stop = true;
    }
    if (chunk.tokenInfo?.hasTokens) {
      result.usage = mapTokenInfo(chunk.tokenInfo);
    }
    return result;
  }

  if (eventType === 'finish') {
    result.stop = true;
    result.finalContent = event.finalContentX || event.finalContent || '';
    if (event.finishType === 'sensitive') result.contentFilter = true;
    const usage = event.usage || {};
    const tokenInfo = chunk.tokenInfo || {};
    result.usage = {
      prompt_tokens: usage.inputTokens ?? tokenInfo.promptTokens ?? 0,
      completion_tokens: usage.outputTokens ?? tokenInfo.completionTokens ?? 0,
      total_tokens: usage.totalTokens ?? tokenInfo.totalTokens ?? 0,
    };
    return result;
  }

  if (eventType === 'create' || eventType === 'summary') {
    return result;
  }

  if (eventType === 'content') {
    // oversea often sends incremental; some variants send cumulative with status
    result.text = event.content || '';
    result.delta = true;
    if (event.status === 'FINISHED' && chunk.lastOne) result.stop = true;
    return result;
  }

  if (eventType === 'reason' || eventType === 'think') {
    result.thinking = event.content || '';
    result.delta = true;
    return result;
  }

  if (['common_search', 'general_search', 'local_life_search'].includes(eventType)) {
    const c = event.content;
    if (typeof c === 'string') result.text = c;
    else if (Array.isArray(c)) {
      result.text = c
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object') {
            return [item.title, item.snippet || item.content].filter(Boolean).join(' ');
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return result;
  }

  if (eventType === 'event_error') {
    result.stop = true;
    result.error = event.message || event.content || 'Unknown error';
    return result;
  }

  if (chunk.lastOne) result.stop = true;
  return result;
}

function mapTokenInfo(ti) {
  return {
    prompt_tokens: ti.promptTokens || 0,
    completion_tokens: ti.completionTokens || 0,
    total_tokens: ti.totalTokens || 0,
  };
}

/**
 * Consume full SSE text body → { text, thinking, usage, error, model }
 */
export function collectFromSseBody(bodyText, { thinkingEnabled = false } = {}) {
  const contentParts = [];
  const thinkingParts = [];
  let usage = {};
  let error = '';
  let contentFilter = false;
  let finalContent = '';
  let model = '';
  let conversationId = '';

  // cumulative trackers for legacy format
  let lastCum = '';

  for (const raw of String(bodyText || '').split('\n')) {
    const r = parseSseLine(raw);
    if (!r.valid) continue;
    if (r.model) model = r.model;
    if (r.conversationId) conversationId = r.conversationId;
    if (r.error) {
      error = r.error;
      break;
    }
    if (r.contentFilter) contentFilter = true;
    if (r.usage && (r.usage.total_tokens || r.usage.prompt_tokens)) usage = r.usage;
    if (r.finalContent) finalContent = r.finalContent;

    if (r.cumulative && r.text != null) {
      // cumulative full content
      if (r.text.length >= lastCum.length) {
        const delta = r.text.slice(lastCum.length);
        if (delta) contentParts.push(delta);
        lastCum = r.text;
      } else {
        contentParts.push(r.text);
        lastCum = r.text;
      }
    } else {
      if (r.thinking) thinkingParts.push(r.thinking);
      if (r.text) contentParts.push(r.text);
    }

    if (r.stop || r.done) break;
  }

  let text = contentParts.join('');
  let thinking = thinkingParts.join('');

  // pure thinking mode: last content is answer, earlier content → thinking
  if (thinkingEnabled && contentParts.length > 1 && !finalContent) {
    thinking = thinking + contentParts.slice(0, -1).join('');
    text = contentParts[contentParts.length - 1];
  } else if (thinkingEnabled && finalContent) {
    if (contentParts.length) thinking = thinking + contentParts.join('');
    text = finalContent;
  } else if (finalContent && !text) {
    text = finalContent;
  }

  return {
    text,
    thinking,
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || Math.max(1, Math.ceil(text.length / 4)),
      total_tokens:
        usage.total_tokens ||
        (usage.prompt_tokens || 0) + (usage.completion_tokens || Math.max(1, Math.ceil(text.length / 4))),
    },
    error,
    contentFilter,
    model,
    conversationId,
  };
}

/**
 * Async iterate SSE lines from a ReadableStream / Node stream
 */
export async function* iterateSseLines(body) {
  if (!body) return;
  // undici body is async iterable of Uint8Array
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      yield line;
    }
  }
  if (buffer.trim()) yield buffer;
}
