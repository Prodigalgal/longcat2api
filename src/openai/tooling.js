import { randomUUID } from 'node:crypto';

function asJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

export function normalizeTools(tools = []) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return null;
      if (tool.type === 'function' && tool.function) {
        return {
          type: 'function',
          name: tool.function.name,
          description: tool.function.description || '',
          parameters: tool.function.parameters || { type: 'object', properties: {} },
          strict: !!tool.function.strict,
        };
      }
      if (tool.type === 'function' && tool.name) {
        return {
          type: 'function',
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} },
          strict: !!tool.strict,
        };
      }
      if (tool.type === 'custom' && tool.name) {
        return {
          type: 'custom',
          name: tool.name,
          description: tool.description || '',
          format: tool.format || null,
        };
      }
      return null;
    })
    .filter((tool) => tool?.name);
}

function normalizedChoice(choice) {
  if (choice == null) return 'auto';
  if (typeof choice === 'string') return choice;
  return choice.function?.name || choice.name || choice.type || 'auto';
}

export function appendGenerationContract(
  prompt,
  { tools = [], toolChoice = 'auto', parallelToolCalls = true, responseFormat = null } = {}
) {
  const sections = [String(prompt || '').trim()];
  const normalized = normalizeTools(tools);
  if (normalized.length) {
    const choice = normalizedChoice(toolChoice);
    sections.push(
      [
        '[Tool calling contract]',
        `Available tools: ${JSON.stringify(normalized)}`,
        `Tool choice: ${choice}. Parallel calls allowed: ${parallelToolCalls !== false}.`,
        'When a tool is needed, output only this JSON object and no prose:',
        '{"tool_calls":[{"name":"tool_name","arguments":{}}]}',
        'When no tool is needed, answer normally without a tool_calls object.',
      ].join('\n')
    );
  }
  if (responseFormat) {
    const type = responseFormat.type || responseFormat.format?.type;
    const schema =
      responseFormat.json_schema?.schema ||
      responseFormat.schema ||
      responseFormat.format?.schema ||
      null;
    if (type === 'json_object') {
      sections.push('[Output contract]\nReturn one valid JSON object and no markdown fence.');
    } else if (type === 'json_schema') {
      sections.push(
        `[Output contract]\nReturn JSON matching this schema exactly and no markdown fence:\n${JSON.stringify(schema || {})}`
      );
    }
  }
  return sections.filter(Boolean).join('\n\n');
}

function jsonCandidates(text) {
  const raw = String(text || '').trim();
  const candidates = [raw];
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1]);
  const tagged = raw.match(/<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/i);
  if (tagged) candidates.push(tagged[1]);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

export function parseToolCalls(text, allowedTools = []) {
  const allowed = new Set(normalizeTools(allowedTools).map((tool) => tool.name));
  if (!allowed.size) return [];
  let value = null;
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) value = { tool_calls: parsed };
      else if (parsed?.tool_calls || parsed?.function_call) value = parsed;
      if (value) break;
    } catch {
      /* next candidate */
    }
  }
  const rawCalls = value?.tool_calls || (value?.function_call ? [value.function_call] : []);
  return rawCalls
    .map((call) => {
      const fn = call.function || call;
      const name = fn.name;
      if (!name || !allowed.has(name)) return null;
      const args = asJson(fn.arguments, fn.arguments ?? {});
      return {
        id: call.id || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      };
    })
    .filter(Boolean);
}

export function validateJsonOutput(text, responseFormat) {
  const type = responseFormat?.type || responseFormat?.format?.type;
  if (type !== 'json_object' && type !== 'json_schema') return null;
  try {
    return JSON.parse(String(text || '').trim());
  } catch {
    const error = new Error('model output is not valid JSON for the requested response format');
    error.status = 502;
    error.code = 'invalid_structured_output';
    throw error;
  }
}
