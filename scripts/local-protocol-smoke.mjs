import assert from 'node:assert/strict';
import { config } from '../src/config.js';

config.load();
const baseUrl = String(process.env.LONGCAT2API_SMOKE_BASE_URL || 'http://127.0.0.1:18084').replace(/\/$/, '');
const apiKey = String(config.data.api_keys || '').split(',').map((value) => value.trim()).find(Boolean);
if (!apiKey) throw new Error('no API key configured');

const headers = {
  authorization: `Bearer ${apiKey}`,
  'content-type': 'application/json',
};

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240000),
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${path} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return { response, text };
}

async function request(method, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: headers.authorization },
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${method} ${path} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function parseSse(text) {
  const events = [];
  let done = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    if (data) events.push(JSON.parse(data));
  }
  return { events, done };
}

function responseText(response) {
  return (response.output || [])
    .flatMap((item) => item.type === 'message' ? item.content || [] : [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text || '')
    .join('');
}

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
};

console.log('[protocol-smoke] Chat streaming tool call');
const chatStream = parseSse((await post('/v1/chat/completions', {
  model: 'LongCat-Flash-Chat',
  messages: [{ role: 'user', content: 'Call get_weather for Xiamen.' }],
  tools: [weatherTool],
  tool_choice: 'required',
  stream: true,
  stream_options: { include_usage: true },
})).text);
assert.equal(chatStream.done, true, 'Chat stream missing [DONE]');
assert.ok(chatStream.events.some((event) => event.choices?.[0]?.delta?.tool_calls), 'Chat stream missing tool_calls delta');
assert.ok(chatStream.events.some((event) => event.choices?.[0]?.finish_reason === 'tool_calls'), 'Chat stream missing tool_calls finish_reason');
assert.ok(chatStream.events.some((event) => event.usage && event.choices?.length === 0), 'Chat stream missing separate usage chunk');

console.log('[protocol-smoke] Responses streaming function call');
const responsesStream = parseSse((await post('/v1/responses', {
  model: 'LongCat-Flash-Chat',
  input: 'Call get_weather for Xiamen.',
  tools: [weatherTool],
  tool_choice: 'required',
  stream: true,
})).text);
const types = responsesStream.events.map((event) => event.type);
assert.ok(types.includes('response.created'), 'Responses stream missing response.created');
assert.ok(types.includes('response.function_call_arguments.delta'), 'Responses stream missing arguments delta');
assert.ok(types.includes('response.function_call_arguments.done'), 'Responses stream missing arguments done');
assert.equal(types.at(-1), 'response.completed', 'Responses stream must end with response.completed');
const sequences = responsesStream.events.map((event) => event.sequence_number);
assert.deepEqual(sequences, sequences.map((_, index) => index), 'Responses sequence_number is not monotonic');

console.log('[protocol-smoke] Responses previous_response_id stickiness');
const first = JSON.parse((await post('/v1/responses', {
  model: 'LongCat-Flash-Chat',
  input: 'Remember this exact code: ALPHA-725. Reply only stored.',
})).text);
assert.ok(first.id?.startsWith('resp_'), 'first response id missing');
const second = JSON.parse((await post('/v1/responses', {
  model: 'LongCat-Flash-Chat',
  input: 'What exact code did I ask you to remember?',
  previous_response_id: first.id,
})).text);
assert.match(responseText(second), /ALPHA-725/i, 'linked response lost prior context');
const retrieved = await request('GET', `/v1/responses/${first.id}`);
assert.equal(retrieved.id, first.id, 'response retrieve returned wrong id');
const inputItems = await request('GET', `/v1/responses/${first.id}/input_items`);
assert.equal(inputItems.object, 'list', 'response input_items did not return a list');
const deleted = await request('DELETE', `/v1/responses/${first.id}`);
assert.equal(deleted.deleted, true, 'response delete was not acknowledged');

console.log('[protocol-smoke] four-way Chat concurrency');
const concurrent = await Promise.all(
  Array.from({ length: 4 }, (_, index) => post('/v1/chat/completions', {
    model: 'LongCat-Flash-Chat',
    messages: [{ role: 'user', content: `Reply only with C${index + 1}.` }],
  }))
);
assert.equal(concurrent.length, 4);

console.log(JSON.stringify({
  ok: true,
  chat_stream_events: chatStream.events.length,
  responses_stream_events: responsesStream.events.length,
  state_linked: true,
  response_lifecycle: true,
  concurrent_ok: concurrent.length,
}));
