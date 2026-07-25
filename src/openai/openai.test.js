import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPromptFromMessages,
  buildPromptFromResponsesInput,
  normalizeChatRequest,
  normalizeResponsesRequest,
  buildChatCompletion,
  buildChatUsageChunk,
  buildResponsesObject,
  streamResponsesEvents,
} from './transform.js';
import { appendGenerationContract, parseToolCalls, validateJsonOutput } from './tooling.js';

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

test('normalizes developer, multimodal, assistant tool calls, and tool results', () => {
  const prompt = buildPromptFromMessages([
    { role: 'developer', content: 'Be concise.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ],
    },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Xiamen"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":31}' },
  ]);
  assert.match(prompt, /\[Developer\]/);
  assert.match(prompt, /\[Image: https:\/\/example\.com\/a\.png\]/);
  assert.match(prompt, /Assistant tool calls/);
  assert.match(prompt, /Tool Result id=call_1/);
});

test('normalizes Responses function call output items', () => {
  const prompt = buildPromptFromResponsesInput({
    instructions: 'Use tools when needed.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather?' }] },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"Xiamen"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":31}' },
    ],
  });
  assert.match(prompt, /\[Developer\]/);
  assert.match(prompt, /call_1/);
  assert.match(prompt, /31/);
});

test('normalizes Chat and Responses tool and output controls', () => {
  const chat = normalizeChatRequest({
    model: 'longcat-flash',
    messages: [{ role: 'user', content: 'Weather?' }],
    tools: [weatherTool],
    tool_choice: 'required',
    parallel_tool_calls: false,
    response_format: { type: 'json_object' },
    stream_options: { include_usage: true },
  });
  assert.equal(chat.tools[0].name, 'get_weather');
  assert.equal(chat.toolChoice, 'required');
  assert.equal(chat.parallelToolCalls, false);
  assert.equal(chat.streamOptions.include_usage, true);

  const response = normalizeResponsesRequest({
    model: 'longcat-flash',
    input: 'Weather?',
    tools: [{ type: 'function', name: 'get_weather', parameters: {} }],
    text: { format: { type: 'json_schema', schema: { type: 'object' } } },
    previous_response_id: 'resp_previous',
  });
  assert.equal(response.tools[0].name, 'get_weather');
  assert.equal(response.responseFormat.type, 'json_schema');
  assert.equal(response.previousResponseId, 'resp_previous');
});

test('encodes and parses a function tool contract', () => {
  const prompt = appendGenerationContract('Weather in Xiamen?', {
    tools: [weatherTool],
    toolChoice: 'required',
  });
  assert.match(prompt, /Tool calling contract/);
  const calls = parseToolCalls(
    '```json\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Xiamen"}}]}\n```',
    [weatherTool]
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: 'Xiamen' });
});

test('renders Chat tool calls and a separate usage chunk', () => {
  const call = {
    id: 'call_1',
    type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"Xiamen"}' },
  };
  const completion = buildChatCompletion({
    id: 'chatcmpl_1',
    model: 'longcat-flash',
    text: '',
    toolCalls: [call],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  });
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
  assert.equal(completion.choices[0].message.content, null);
  assert.equal(completion.choices[0].message.tool_calls[0].id, 'call_1');
  const usage = buildChatUsageChunk({
    id: 'chatcmpl_1',
    model: 'longcat-flash',
    usage: completion.usage,
  });
  assert.deepEqual(usage.choices, []);
  assert.equal(usage.usage.total_tokens, 5);
});

test('renders Responses function calls and ordered streaming events', () => {
  const toolCalls = [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Xiamen"}' },
    },
  ];
  const response = buildResponsesObject({
    id: 'resp_1',
    model: 'longcat-flash',
    text: '',
    toolCalls,
    request: { tools: [weatherTool], toolChoice: 'required' },
  });
  assert.equal(response.output[0].type, 'function_call');
  assert.equal(response.output[0].call_id, 'call_1');

  const events = [...streamResponsesEvents({
    id: 'resp_1',
    model: 'longcat-flash',
    text: '',
    toolCalls,
  })].map((line) => JSON.parse(line.slice(6)));
  assert.ok(events.some((event) => event.type === 'response.function_call_arguments.delta'));
  assert.equal(events.at(-1).type, 'response.completed');
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_, index) => index)
  );
});

test('rejects invalid JSON when structured output was requested', () => {
  assert.throws(
    () => validateJsonOutput('not-json', { type: 'json_object' }),
    /not valid JSON/
  );
});
