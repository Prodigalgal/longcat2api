function imageReference(part) {
  const value = part?.image_url?.url ?? part?.image_url ?? part?.url ?? part?.file_id;
  return value ? `[Image: ${String(value)}]` : '[Image input]';
}

export function extractTextContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (typeof content === 'object' && content.text) return String(content.text);
    return String(content);
  }
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (['text', 'input_text', 'output_text'].includes(part.type)) return part.text || '';
      if (['image_url', 'input_image'].includes(part.type)) return imageReference(part);
      if (part.type === 'input_file') {
        return `[File: ${part.filename || part.file_id || part.file_url || 'input'}]`;
      }
      if (part.type === 'input_audio') {
        return `[Audio input${part.input_audio?.format ? ` (${part.input_audio.format})` : ''}]`;
      }
      if (part.type === 'refusal') return `[Refusal] ${part.refusal || ''}`;
      if (part.text) return String(part.text);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function buildPromptFromMessages(messages = []) {
  const parts = [];
  for (const message of messages) {
    const role = message.role || 'user';
    let content = extractTextContent(message.content);
    if (message.tool_calls?.length) {
      const calls = message.tool_calls.map((call) => ({
        id: call.id,
        name: call.function?.name || call.name,
        arguments: call.function?.arguments || call.arguments || '{}',
      }));
      content += `${content ? '\n' : ''}[Assistant tool calls]\n${JSON.stringify(calls)}`;
    }
    if (message.function_call) {
      content += `${content ? '\n' : ''}[Assistant function call]\n${JSON.stringify(message.function_call)}`;
    }
    if (!content && !['tool', 'function'].includes(role)) continue;
    if (role === 'developer') parts.push(`[Developer]\n${content}`);
    else if (role === 'system') parts.push(`[System]\n${content}`);
    else if (role === 'user') parts.push(`[User]\n${content}`);
    else if (role === 'assistant') parts.push(`[Assistant]\n${content}`);
    else if (role === 'tool') {
      parts.push(
        `[Tool Result id=${message.tool_call_id || ''} name=${message.name || ''}]\n${content}`
      );
    } else if (role === 'function') {
      parts.push(`[Function Result name=${message.name || ''}]\n${content}`);
    } else parts.push(`[${role}]\n${content}`);
  }
  return parts.join('\n\n').trim();
}

export function buildPromptFromResponsesInput(body = {}) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'developer', content: body.instructions });
  if (typeof body.input === 'string') messages.push({ role: 'user', content: body.input });
  else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item?.type === 'message' || item?.role) {
        messages.push({ role: item.role || 'user', content: item.content });
      } else if (item?.type === 'function_call') {
        messages.push({
          role: 'assistant',
          tool_calls: [
            {
              id: item.call_id || item.id,
              type: 'function',
              function: { name: item.name, arguments: item.arguments || '{}' },
            },
          ],
        });
      } else if (item?.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: item.output,
        });
      } else if (item?.type === 'custom_tool_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: item.output,
        });
      }
    }
  }
  return buildPromptFromMessages(messages);
}
