import { Router } from 'express';
import {
  updateAccount,
  addUsage,
  addRequestLog,
} from '../db/index.js';
import { acquireChatContext, runChat } from '../services/chatService.js';
import { accountCoordinator } from '../services/accountCoordinator.js';
import { sessionStats } from '../services/sessionStore.js';
import { linkResponseToSession } from '../services/sessionStore.js';
import { listModels } from '../openai/models.js';
import {
  normalizeChatRequest,
  normalizeResponsesRequest,
  chatCompletionId,
  responseId,
  buildChatCompletion,
  buildChatChunk,
  buildChatUsageChunk,
  buildResponsesObject,
  streamResponsesEvents,
  sseData,
} from '../openai/transform.js';
import { prepareGeneration, interpretGeneration } from '../openai/generation.js';
import {
  deleteResponse,
  getResponse,
  getResponseInputItems,
  saveResponse,
} from '../openai/responseStore.js';
import { requireApiKey } from '../middleware/auth.js';

const router = Router();

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  req.once('aborted', () => controller.abort(new Error('client request aborted')));
  res.once('close', () => {
    if (!res.writableEnded) controller.abort(new Error('client connection closed'));
  });
  return controller.signal;
}

function writeChatStream(res, { id, model, result, streamOptions = {} }) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(
    sseData(
      buildChatChunk({
        id,
        model,
        delta: { role: 'assistant' },
      })
    )
  );
  if (result.thinking) {
    res.write(
      sseData(
        buildChatChunk({
          id,
          model,
          delta: { reasoning_content: result.thinking },
        })
      )
    );
  }
  if (result.toolCalls?.length) {
    result.toolCalls.forEach((call, index) => {
      res.write(
        sseData(
          buildChatChunk({
            id,
            model,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.function.name, arguments: '' },
                },
              ],
            },
          })
        )
      );
      res.write(
        sseData(
          buildChatChunk({
            id,
            model,
            delta: {
              tool_calls: [
                {
                  index,
                  function: { arguments: call.function.arguments },
                },
              ],
            },
          })
        )
      );
    });
  } else if (result.text) {
    const step = 64;
    for (let i = 0; i < result.text.length; i += step) {
      res.write(
        sseData(
          buildChatChunk({
            id,
            model,
            delta: { content: result.text.slice(i, i + step) },
          })
        )
      );
    }
  }
  res.write(
    sseData(
      buildChatChunk({
        id,
        model,
        delta: {},
        finishReason: result.toolCalls?.length
          ? 'tool_calls'
          : result.contentFilter
            ? 'content_filter'
            : 'stop',
      })
    )
  );
  if (streamOptions.include_usage) {
    res.write(sseData(buildChatUsageChunk({ id, model, usage: result.usage })));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

router.get('/v1/models', requireApiKey, (_req, res) => {
  res.json(listModels());
});

/** Pool / session runtime (for clients & admin) */
router.get('/v1/pool/status', requireApiKey, (_req, res) => {
  res.json({
    ok: true,
    coordinator: accountCoordinator.status(),
    sessions: sessionStats(),
  });
});

router.post('/v1/chat/completions', requireApiKey, async (req, res) => {
  const started = Date.now();
  let lease = null;
  let mode = 'session';
  const signal = requestAbortSignal(req, res);

  try {
    const std = normalizeChatRequest(req.body || {}, mode);
    mode = std.mode;
    if (!std.prompt) {
      return res.status(400).json({
        error: { message: 'messages required', type: 'invalid_request_error' },
      });
    }

    const ctx = await acquireChatContext(req, { model: std.model, signal });
    lease = ctx.lease;
    const account = lease.account;
    const id = chatCompletionId();

    let result = await runChat({
      lease,
      sticky: ctx.sticky,
      content: prepareGeneration(std),
      agentId: std.agentId,
      reasonEnabled: std.reason,
      searchEnabled: std.search,
      messages: req.body?.messages || [],
    });
    result = interpretGeneration(std, result);

    addUsage({
      prompt: result.usage?.prompt_tokens || 0,
      completion: result.usage?.completion_tokens || 0,
    });
    addRequestLog({
      account_id: account.id,
      model: std.model,
      mode,
      stream: !!std.stream,
      status: 200,
      latency_ms: Date.now() - started,
      prompt_tokens: result.usage?.prompt_tokens || 0,
      completion_tokens: result.usage?.completion_tokens || 0,
      path: '/v1/chat/completions',
    });

    if (std.stream) {
      writeChatStream(res, {
        id,
        model: std.model,
        result,
        streamOptions: std.streamOptions,
      });
      return;
    }

    return res.json(
      buildChatCompletion({
        id,
        model: std.model,
        text: result.text,
        thinking: result.thinking,
        toolCalls: result.toolCalls,
        usage: result.usage,
        finishReason: result.contentFilter ? 'content_filter' : 'stop',
      })
    );
  } catch (e) {
    const account = lease?.account;
    if (account && (e.status === 401 || e.status === 403)) {
      updateAccount(account.id, {
        is_valid: false,
        error_count: (account.error_count || 0) + 1,
        renew_error: e.message,
      });
    }
    addRequestLog({
      account_id: account?.id,
      model: req.body?.model,
      mode,
      stream: !!req.body?.stream,
      status: e.status || 500,
      latency_ms: Date.now() - started,
      error: e.message,
      path: '/v1/chat/completions',
    });
    if (!res.headersSent) {
      return res.status(e.status || 500).json({
        error: {
          message: e.message || 'internal error',
          type: 'server_error',
          code: e.code || undefined,
        },
      });
    }
    res.end();
  } finally {
    try {
      lease?.release?.();
    } catch {
      /* ignore */
    }
  }
});

/**
 * OpenAI Responses API
 * POST /v1/responses
 * GET  /v1/responses/:id  (best-effort from recent logs — not full store)
 */
router.post('/v1/responses', requireApiKey, async (req, res) => {
  const started = Date.now();
  let lease = null;
  let mode = 'session';
  const signal = requestAbortSignal(req, res);

  try {
    const std = normalizeResponsesRequest(req.body || {}, mode);
    mode = std.mode;
    if (!std.prompt) {
      return res.status(400).json({
        error: { message: 'input required', type: 'invalid_request_error' },
      });
    }

    const id = responseId();
    const ctx = await acquireChatContext(req, {
      model: std.model,
      signal,
      fallbackSessionId: id,
    });
    lease = ctx.lease;
    const account = lease.account;

    let result = await runChat({
      lease,
      sticky: ctx.sticky,
      content: prepareGeneration(std),
      agentId: std.agentId,
      reasonEnabled: std.reason,
      searchEnabled: std.search,
    });
    result = interpretGeneration(std, result);

    addUsage({
      prompt: result.usage?.prompt_tokens || 0,
      completion: result.usage?.completion_tokens || 0,
    });
    addRequestLog({
      account_id: account.id,
      model: std.model,
      mode,
      stream: !!std.stream,
      status: 200,
      latency_ms: Date.now() - started,
      prompt_tokens: result.usage?.prompt_tokens || 0,
      completion_tokens: result.usage?.completion_tokens || 0,
      path: '/v1/responses',
    });
    linkResponseToSession(id, ctx.sticky?.key);
    const responseRequest = {
      ...std,
      metadata: {
        ...(std.metadata || {}),
        ...(ctx.clientSid ? { session_id: ctx.clientSid } : {}),
        ...(result.conversationId ? { conversation_id: result.conversationId } : {}),
      },
    };
    const responseBody = buildResponsesObject({
      id,
      model: std.model,
      text: result.text,
      thinking: result.thinking,
      toolCalls: result.toolCalls,
      usage: result.usage,
      request: responseRequest,
    });
    if (std.store) {
      saveResponse({
        tenant: req.apiKeyId,
        response: responseBody,
        input: req.body?.input,
      });
    }

    if (std.stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      for (const chunk of streamResponsesEvents({
        id,
        model: std.model,
        text: result.text,
        thinking: result.thinking,
        toolCalls: result.toolCalls,
        usage: result.usage,
        request: responseRequest,
      })) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    return res.json(responseBody);
  } catch (e) {
    const account = lease?.account;
    if (account && (e.status === 401 || e.status === 403)) {
      updateAccount(account.id, {
        is_valid: false,
        error_count: (account.error_count || 0) + 1,
        renew_error: e.message,
      });
    }
    addRequestLog({
      account_id: account?.id,
      model: req.body?.model,
      mode,
      stream: !!req.body?.stream,
      status: e.status || 500,
      latency_ms: Date.now() - started,
      error: e.message,
      path: '/v1/responses',
    });
    return res.status(e.status || 500).json({
      error: {
        message: e.message || 'internal error',
        type: 'server_error',
        code: e.code || undefined,
      },
    });
  } finally {
    try {
      lease?.release?.();
    } catch {
      /* ignore */
    }
  }
});

router.get('/v1/responses/:id/input_items', requireApiKey, (req, res) => {
  const items = getResponseInputItems(req.params.id, req.apiKeyId);
  if (!items) {
    return res.status(404).json({
      error: { message: `Response not found: ${req.params.id}`, type: 'invalid_request_error' },
    });
  }
  res.json(items);
});

router.get('/v1/responses/:id', requireApiKey, (req, res) => {
  const response = getResponse(req.params.id, req.apiKeyId);
  if (!response) {
    return res.status(404).json({
      error: { message: `Response not found: ${req.params.id}`, type: 'invalid_request_error' },
    });
  }
  res.json(response);
});

router.delete('/v1/responses/:id', requireApiKey, (req, res) => {
  const deleted = deleteResponse(req.params.id, req.apiKeyId);
  if (!deleted) {
    return res.status(404).json({
      error: { message: `Response not found: ${req.params.id}`, type: 'invalid_request_error' },
    });
  }
  res.json({ id: req.params.id, object: 'response.deleted', deleted: true });
});

// Common aliases
router.post('/chat/completions', requireApiKey, (req, res, next) => {
  req.url = '/v1/chat/completions';
  router.handle(req, res, next);
});
router.post('/responses', requireApiKey, (req, res, next) => {
  req.url = '/v1/responses';
  router.handle(req, res, next);
});

export default router;
