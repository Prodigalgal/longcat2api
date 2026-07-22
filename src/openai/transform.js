import { randomUUID } from 'node:crypto';
import { resolveModel } from './models.js';

export function extractTextContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.type === 'input_text') return part.text || '';
        if (part?.text) return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && content.text) return String(content.text);
  return String(content);
}

/**
 * Flatten OpenAI messages → single prompt string for LongCat web
 */
export function buildPromptFromMessages(messages = []) {
  const parts = [];
  for (const msg of messages) {
    const role = msg.role || 'user';
    let content = extractTextContent(msg.content);
    if (msg.tool_calls?.length) {
      content +=
        (content ? '\n' : '') +
        msg.tool_calls
          .map((tc) => {
            const fn = tc.function || {};
            return `[tool_call ${fn.name}] ${fn.arguments || ''}`;
          })
          .join('\n');
    }
    if (!content && role !== 'tool') continue;
    if (role === 'system') parts.push(`[System]\n${content}`);
    else if (role === 'user') parts.push(`[User]\n${content}`);
    else if (role === 'assistant') parts.push(`[Assistant]\n${content}`);
    else if (role === 'tool') parts.push(`[Tool Result: ${msg.name || 'tool'}]\n${content}`);
    else parts.push(`[${role}]\n${content}`);
  }
  return parts.join('\n\n').trim();
}

/**
 * OpenAI Responses API input → messages-like prompt
 */
export function buildPromptFromResponsesInput(body) {
  if (typeof body.input === 'string') return body.input;
  if (Array.isArray(body.input)) {
    // items: {role, content} or content parts
    const msgs = [];
    for (const item of body.input) {
      if (typeof item === 'string') {
        msgs.push({ role: 'user', content: item });
        continue;
      }
      if (item.role) {
        msgs.push({ role: item.role, content: item.content });
        continue;
      }
      if (item.type === 'message') {
        msgs.push({ role: item.role || 'user', content: item.content });
      }
    }
    if (body.instructions) {
      msgs.unshift({ role: 'system', content: body.instructions });
    }
    return buildPromptFromMessages(msgs);
  }
  if (body.instructions) return String(body.instructions);
  return '';
}

export function normalizeChatRequest(body, defaultMode = 'oversea') {
  const modelMeta = resolveModel(body.model);
  let reason = modelMeta.reason;
  let search = modelMeta.search;
  if (body.reason_enabled != null) reason = !!body.reason_enabled;
  if (body.search_enabled != null) search = !!body.search_enabled;
  if (body.reasoning_effort && body.reasoning_effort !== 'none') reason = true;

  // model suffix :cn / :oversea
  let mode = defaultMode;
  const mid = String(body.model || '');
  if (mid.endsWith(':cn') || body.mode === 'cn') mode = 'cn';
  if (mid.endsWith(':oversea') || body.mode === 'oversea') mode = 'oversea';

  const prompt = buildPromptFromMessages(body.messages || []);
  return {
    model: modelMeta.id,
    agentId: modelMeta.agentId,
    reason,
    search,
    mode,
    stream: !!body.stream,
    prompt,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    tools: body.tools || [],
  };
}

export function normalizeResponsesRequest(body, defaultMode = 'oversea') {
  const modelMeta = resolveModel(body.model);
  let reason = modelMeta.reason;
  let search = modelMeta.search;
  if (body.reasoning?.effort && body.reasoning.effort !== 'none') reason = true;

  let mode = defaultMode;
  if (body.mode === 'cn') mode = 'cn';
  if (body.mode === 'oversea') mode = 'oversea';

  return {
    model: modelMeta.id,
    agentId: modelMeta.agentId,
    reason,
    search,
    mode,
    stream: !!body.stream,
    prompt: buildPromptFromResponsesInput(body),
  };
}

export function chatCompletionId() {
  return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function responseId() {
  return `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function buildChatCompletion({ id, model, text, thinking, usage, finishReason = 'stop' }) {
  const message = { role: 'assistant', content: text || '' };
  if (thinking) {
    message.reasoning_content = thinking;
  }
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function buildChatChunk({ id, model, delta, finishReason = null, usage = null }) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

export function sseData(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * OpenAI Responses API non-stream body
 */
export function buildResponsesObject({ id, model, text, thinking, usage, status = 'completed' }) {
  const output = [];
  if (thinking) {
    output.push({
      type: 'reasoning',
      id: `rs_${id.slice(5, 15)}`,
      summary: [{ type: 'summary_text', text: thinking }],
    });
  }
  output.push({
    type: 'message',
    id: `msg_${id.slice(5, 15)}`,
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text: text || '',
        annotations: [],
      },
    ],
  });
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
      total_tokens: usage?.total_tokens || 0,
    },
  };
}

export function* streamResponsesEvents({ id, model, text, thinking, usage }) {
  yield sseData({
    type: 'response.created',
    response: { id, object: 'response', status: 'in_progress', model },
  });
  yield sseData({ type: 'response.in_progress', response: { id, status: 'in_progress' } });

  if (thinking) {
    const itemId = `rs_${id.slice(5, 12)}`;
    yield sseData({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: itemId },
    });
    yield sseData({
      type: 'response.reasoning_summary_text.delta',
      item_id: itemId,
      delta: thinking,
    });
    yield sseData({
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: itemId },
    });
  }

  const msgId = `msg_${id.slice(5, 12)}`;
  const outIndex = thinking ? 1 : 0;
  yield sseData({
    type: 'response.output_item.added',
    output_index: outIndex,
    item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress' },
  });
  yield sseData({
    type: 'response.content_part.added',
    item_id: msgId,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });

  // emit text in chunks for better UX
  const chunkSize = 48;
  const full = text || '';
  for (let i = 0; i < full.length; i += chunkSize) {
    const delta = full.slice(i, i + chunkSize);
    yield sseData({
      type: 'response.output_text.delta',
      item_id: msgId,
      content_index: 0,
      delta,
    });
  }

  yield sseData({
    type: 'response.output_text.done',
    item_id: msgId,
    content_index: 0,
    text: full,
  });
  yield sseData({
    type: 'response.content_part.done',
    item_id: msgId,
    content_index: 0,
    part: { type: 'output_text', text: full, annotations: [] },
  });
  yield sseData({
    type: 'response.output_item.done',
    output_index: outIndex,
    item: {
      type: 'message',
      id: msgId,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: full, annotations: [] }],
    },
  });

  const resp = buildResponsesObject({ id, model, text, thinking, usage, status: 'completed' });
  yield sseData({ type: 'response.completed', response: resp });
}
