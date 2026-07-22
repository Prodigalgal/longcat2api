import { Router } from 'express';
import {
  pickAccountRoundRobin,
  updateAccount,
  addUsage,
  addRequestLog,
} from '../db/index.js';
import { chatCollect } from '../services/longcatClient.js';
import { listModels } from '../openai/models.js';
import {
  normalizeChatRequest,
  normalizeResponsesRequest,
  chatCompletionId,
  responseId,
  buildChatCompletion,
  buildChatChunk,
  buildResponsesObject,
  streamResponsesEvents,
  sseData,
} from '../openai/transform.js';
import { requireApiKey } from '../middleware/auth.js';

const router = Router();

router.get('/v1/models', requireApiKey, (_req, res) => {
  res.json(listModels());
});

router.post('/v1/chat/completions', requireApiKey, async (req, res) => {
  const started = Date.now();
  let account = null;
  let mode = 'session';
  try {
    const std = normalizeChatRequest(req.body || {}, mode);
    mode = std.mode;

    account = pickAccountRoundRobin();
    if (!account) {
      return res.status(503).json({
        error: {
          message:
            'no valid logged-in account; import longcat.chat Cookie (passport_token_key) first',
          type: 'server_error',
          code: 'no_account',
        },
      });
    }

    if (!std.prompt) {
      return res.status(400).json({
        error: { message: 'messages required', type: 'invalid_request_error' },
      });
    }

    const id = chatCompletionId();

    if (std.stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      try {
        const result = await chatCollect({
          account,
          content: std.prompt,
          agentId: std.agentId,
          reasonEnabled: std.reason,
          searchEnabled: std.search,
        });

        res.write(
          sseData(
            buildChatChunk({
              id,
              model: std.model,
              delta: { role: 'assistant' },
            })
          )
        );
        if (result.thinking) {
          res.write(
            sseData(
              buildChatChunk({
                id,
                model: std.model,
                delta: { reasoning_content: result.thinking },
              })
            )
          );
        }
        if (result.text) {
          // chunk content
          const step = 64;
          for (let i = 0; i < result.text.length; i += step) {
            res.write(
              sseData(
                buildChatChunk({
                  id,
                  model: std.model,
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
              model: std.model,
              delta: {},
              finishReason: result.contentFilter ? 'content_filter' : 'stop',
              usage: result.usage,
            })
          )
        );
        res.write('data: [DONE]\n\n');
        res.end();

        if (account) {
          updateAccount(account.id, { is_valid: true, error_count: 0 });
        }
        addUsage({
          prompt: result.usage.prompt_tokens,
          completion: result.usage.completion_tokens,
        });
        addRequestLog({
          account_id: account?.id,
          model: std.model,
          mode,
          stream: true,
          status: 200,
          latency_ms: Date.now() - started,
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens,
          path: '/v1/chat/completions',
        });
      } catch (e) {
        if (account && (e.status === 401 || e.status === 403)) {
          updateAccount(account.id, {
            is_valid: false,
            error_count: (account.error_count || 0) + 1,
            renew_error: e.message,
          });
        }
        if (!res.headersSent) {
          return res.status(e.status || 500).json({
            error: { message: e.message, type: 'server_error' },
          });
        }
        res.write(
          sseData(
            buildChatChunk({
              id,
              model: std.model,
              delta: { content: `Error: ${e.message}` },
              finishReason: 'stop',
            })
          )
        );
        res.write('data: [DONE]\n\n');
        res.end();
      }
      return;
    }

    // non-stream (session + cookie only)
    const result = await chatCollect({
      account,
      content: std.prompt,
      agentId: std.agentId,
      reasonEnabled: std.reason,
      searchEnabled: std.search,
    });

    if (account) updateAccount(account.id, { is_valid: true, error_count: 0 });
    addUsage({
      prompt: result.usage.prompt_tokens,
      completion: result.usage.completion_tokens,
    });
    addRequestLog({
      account_id: account?.id,
      model: std.model,
      mode,
      stream: false,
      status: 200,
      latency_ms: Date.now() - started,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      path: '/v1/chat/completions',
    });

    return res.json(
      buildChatCompletion({
        id,
        model: std.model,
        text: result.text,
        thinking: result.thinking,
        usage: result.usage,
        finishReason: result.contentFilter ? 'content_filter' : 'stop',
      })
    );
  } catch (e) {
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
    return res.status(e.status || 500).json({
      error: { message: e.message || 'internal error', type: 'server_error' },
    });
  }
});

/**
 * OpenAI Responses API
 * POST /v1/responses
 */
router.post('/v1/responses', requireApiKey, async (req, res) => {
  const started = Date.now();
  let account = null;
  let mode = 'session';
  try {
    const std = normalizeResponsesRequest(req.body || {}, mode);
    mode = std.mode;
    account = pickAccountRoundRobin();
    if (!account) {
      return res.status(503).json({
        error: {
          message:
            'no valid logged-in account; import longcat.chat Cookie (passport_token_key) first',
          type: 'server_error',
          code: 'no_account',
        },
      });
    }
    if (!std.prompt) {
      return res.status(400).json({
        error: { message: 'input required', type: 'invalid_request_error' },
      });
    }

    const id = responseId();
    const result = await chatCollect({
      account,
      content: std.prompt,
      agentId: std.agentId,
      reasonEnabled: std.reason,
      searchEnabled: std.search,
    });

    if (account) updateAccount(account.id, { is_valid: true, error_count: 0 });
    addUsage({
      prompt: result.usage.prompt_tokens,
      completion: result.usage.completion_tokens,
    });
    addRequestLog({
      account_id: account?.id,
      model: std.model,
      mode,
      stream: !!std.stream,
      status: 200,
      latency_ms: Date.now() - started,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      path: '/v1/responses',
    });

    if (std.stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      for (const chunk of streamResponsesEvents({
        id,
        model: std.model,
        text: result.text,
        thinking: result.thinking,
        usage: result.usage,
      })) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    return res.json(
      buildResponsesObject({
        id,
        model: std.model,
        text: result.text,
        thinking: result.thinking,
        usage: result.usage,
      })
    );
  } catch (e) {
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
      error: { message: e.message || 'internal error', type: 'server_error' },
    });
  }
});

export default router;
