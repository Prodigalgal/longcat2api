import { randomUUID } from 'node:crypto';
import { resolveModel } from './models.js';
import {
  extractTextContent,
  buildPromptFromMessages,
  buildPromptFromResponsesInput,
} from './content.js';
import { normalizeTools } from './tooling.js';

export { extractTextContent, buildPromptFromMessages, buildPromptFromResponsesInput };

export function normalizeChatRequest(body, _defaultMode = 'session') {
  if (body.n != null && Number(body.n) !== 1) {
    const error = new Error('this gateway supports n=1 only');
    error.status = 400;
    error.code = 'unsupported_n';
    throw error;
  }
  const modelMeta = resolveModel(body.model);
  let reason = modelMeta.reason;
  let search = modelMeta.search;
  if (body.reason_enabled != null) reason = !!body.reason_enabled;
  if (body.search_enabled != null) search = !!body.search_enabled;
  if (body.reasoning_effort && body.reasoning_effort !== 'none') reason = true;

  // Guest oversea chat is disabled — always logged-in session + cookie pool.
  const mid = String(body.model || '');
  if (mid.endsWith(':oversea') || body.mode === 'oversea') {
    const err = new Error(
      'oversea/guest mode is disabled; import a longcat.chat Cookie account and use session mode'
    );
    err.status = 400;
    throw err;
  }

  const legacyTools = Array.isArray(body.functions)
    ? body.functions.map((fn) => ({ type: 'function', function: fn }))
    : [];
  const tools = normalizeTools(body.tools?.length ? body.tools : legacyTools);
  const toolChoice = body.tool_choice ?? body.function_call ?? 'auto';
  const prompt = buildPromptFromMessages(body.messages || []);
  return {
    model: modelMeta.id,
    agentId: modelMeta.agentId,
    reason,
    search,
    mode: 'session',
    stream: !!body.stream,
    prompt,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    stop: body.stop,
    temperature: body.temperature,
    topP: body.top_p,
    seed: body.seed,
    tools,
    toolChoice,
    parallelToolCalls: body.parallel_tool_calls !== false,
    responseFormat: body.response_format || null,
    streamOptions: body.stream_options || {},
    metadata: body.metadata || null,
  };
}

export function normalizeResponsesRequest(body, _defaultMode = 'session') {
  if (body.previous_response_id && body.conversation) {
    const error = new Error('previous_response_id and conversation cannot be used together');
    error.status = 400;
    error.code = 'invalid_state_parameters';
    throw error;
  }
  if (body.background === true) {
    const error = new Error('background responses are not supported by this synchronous gateway');
    error.status = 400;
    error.code = 'unsupported_background';
    throw error;
  }
  const modelMeta = resolveModel(body.model);
  let reason = modelMeta.reason;
  let search = modelMeta.search;
  if (body.reasoning?.effort && body.reasoning.effort !== 'none') reason = true;

  if (body.mode === 'oversea') {
    const err = new Error(
      'oversea/guest mode is disabled; import a longcat.chat Cookie account and use session mode'
    );
    err.status = 400;
    throw err;
  }

  const tools = normalizeTools(body.tools || []);
  return {
    model: modelMeta.id,
    agentId: modelMeta.agentId,
    reason,
    search,
    mode: 'session',
    stream: !!body.stream,
    prompt: buildPromptFromResponsesInput(body),
    tools,
    toolChoice: body.tool_choice ?? 'auto',
    parallelToolCalls: body.parallel_tool_calls !== false,
    responseFormat: body.text?.format || null,
    maxTokens: body.max_output_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    metadata: body.metadata || null,
    instructions: body.instructions || null,
    previousResponseId: body.previous_response_id || null,
    store: body.store !== false,
    include: Array.isArray(body.include) ? body.include : [],
  };
}

export function chatCompletionId() {
  return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function responseId() {
  return `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function buildChatCompletion({
  id,
  model,
  text,
  thinking,
  usage,
  toolCalls = [],
  finishReason = 'stop',
}) {
  const message = {
    role: 'assistant',
    content: toolCalls.length && !text ? null : text || '',
  };
  if (thinking) {
    message.reasoning_content = thinking;
  }
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? 'tool_calls' : finishReason,
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

export function buildChatUsageChunk({ id, model, usage }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage,
  };
}

export function sseData(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * OpenAI Responses API non-stream body
 */
export function buildResponsesObject({
  id,
  model,
  text,
  thinking,
  usage,
  toolCalls = [],
  request = {},
  status = 'completed',
}) {
  const output = [];
  if (thinking) {
    output.push({
      type: 'reasoning',
      id: `rs_${id.slice(5, 15)}`,
      summary: [{ type: 'summary_text', text: thinking }],
    });
  }
  for (const call of toolCalls) {
    output.push({
      type: 'function_call',
      id: `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: 'completed',
    });
  }
  if (text || !toolCalls.length) {
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
  }
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    error: null,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    metadata: request.metadata || {},
    parallel_tool_calls: request.parallelToolCalls !== false,
    temperature: request.temperature ?? 1,
    tool_choice: request.toolChoice ?? 'auto',
    tools: request.tools || [],
    top_p: request.topP ?? 1,
    max_output_tokens: request.maxTokens ?? null,
    previous_response_id: request.previousResponseId ?? null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
      total_tokens: usage?.total_tokens || 0,
    },
  };
}

export function* streamResponsesEvents({
  id,
  model,
  text,
  thinking,
  usage,
  toolCalls = [],
  request = {},
}) {
  let sequence = 0;
  const event = (value) => sseData({ ...value, sequence_number: sequence++ });
  yield event({
    type: 'response.created',
    response: { id, object: 'response', status: 'in_progress', model },
  });
  yield event({ type: 'response.in_progress', response: { id, status: 'in_progress' } });

  if (thinking) {
    const itemId = `rs_${id.slice(5, 12)}`;
    yield event({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: itemId },
    });
    yield event({
      type: 'response.reasoning_summary_text.delta',
      item_id: itemId,
      delta: thinking,
    });
    yield event({
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: itemId },
    });
  }

  let outIndex = thinking ? 1 : 0;
  for (const call of toolCalls) {
    const itemId = `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const item = {
      type: 'function_call',
      id: itemId,
      call_id: call.id,
      name: call.function.name,
      arguments: '',
      status: 'in_progress',
    };
    yield event({ type: 'response.output_item.added', output_index: outIndex, item });
    yield event({
      type: 'response.function_call_arguments.delta',
      item_id: itemId,
      output_index: outIndex,
      delta: call.function.arguments,
    });
    yield event({
      type: 'response.function_call_arguments.done',
      item_id: itemId,
      output_index: outIndex,
      arguments: call.function.arguments,
    });
    yield event({
      type: 'response.output_item.done',
      output_index: outIndex,
      item: { ...item, arguments: call.function.arguments, status: 'completed' },
    });
    outIndex++;
  }

  const msgId = `msg_${id.slice(5, 12)}`;
  if (text || !toolCalls.length) {
    yield event({
      type: 'response.output_item.added',
      output_index: outIndex,
      item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress' },
    });
    yield event({
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
      yield event({
        type: 'response.output_text.delta',
        item_id: msgId,
        content_index: 0,
        delta,
      });
    }

    yield event({
      type: 'response.output_text.done',
      item_id: msgId,
      content_index: 0,
      text: full,
    });
    yield event({
      type: 'response.content_part.done',
      item_id: msgId,
      content_index: 0,
      part: { type: 'output_text', text: full, annotations: [] },
    });
    yield event({
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
  }

  const resp = buildResponsesObject({
    id,
    model,
    text,
    thinking,
    usage,
    toolCalls,
    request,
    status: 'completed',
  });
  yield event({ type: 'response.completed', response: resp });
}
