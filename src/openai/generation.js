import {
  appendGenerationContract,
  parseToolCalls,
  validateJsonOutput,
} from './tooling.js';

function requiresTool(choice) {
  if (choice === 'required') return true;
  if (!choice || typeof choice === 'string') return false;
  return choice.type === 'function' || !!choice.function?.name || !!choice.name;
}

export function prepareGeneration(std) {
  return appendGenerationContract(std.prompt, {
    tools: std.tools,
    toolChoice: std.toolChoice,
    parallelToolCalls: std.parallelToolCalls,
    responseFormat: std.responseFormat,
  });
}

export function interpretGeneration(std, result) {
  const toolCalls = parseToolCalls(result.text, std.tools);
  if (requiresTool(std.toolChoice) && !toolCalls.length) {
    const error = new Error('model did not produce the required tool call');
    error.status = 502;
    error.code = 'required_tool_call_missing';
    throw error;
  }
  if (!toolCalls.length) validateJsonOutput(result.text, std.responseFormat);
  return {
    ...result,
    text: toolCalls.length ? '' : result.text,
    toolCalls,
  };
}
