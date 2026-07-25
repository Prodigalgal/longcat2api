/**
 * High-level chat orchestration:
 *  - sticky session → fixed account + conversationId
 *  - account concurrency lease
 *  - optional context compression
 */

import {
  listValidAccounts,
  getAccount,
  updateAccount,
  markAccountUsed,
} from '../db/index.js';
import { accountCoordinator } from './accountCoordinator.js';
import {
  findSession,
  findSessionByResponseId,
  createSessionRow,
  recordSessionUsage,
  rememberMessages,
  rotateAfterCompaction,
  compressMessages,
  extractClientSessionId,
} from './sessionStore.js';
import {
  createSession as longcatCreateSession,
  chatCollect,
  chatCollectWithConversation,
} from './longcatClient.js';

/**
 * Resolve account + optional sticky conversation for a request.
 */
export async function acquireChatContext(req, { model, signal, fallbackSessionId = '' } = {}) {
  const body = req.body || {};
  const explicitSid = String(extractClientSessionId(req, body) || '').trim();
  const clientSid = explicitSid || String(fallbackSessionId || '').trim();
  const stickyEnabled =
    process.env.LONGCAT2API_SESSION_STICKY !== '0' &&
    (body.session_id || body.user || req.headers['x-session-id'] || body.sticky !== false);

  let sticky = null;
  let preferredAccount = null;

  if (body.previous_response_id) {
    sticky = findSessionByResponseId(body.previous_response_id);
    if (!sticky) {
      const error = new Error(`previous_response_id not found: ${body.previous_response_id}`);
      error.status = 400;
      error.code = 'invalid_previous_response_id';
      throw error;
    }
  }

  if (!sticky && stickyEnabled && clientSid) {
    sticky = findSession({
      tenant: req.apiKeyId || 'default',
      model: model || body.model || '',
      sessionId: clientSid,
    });
  }
  if (sticky?.accountId) {
    preferredAccount = getAccount(sticky.accountId);
    if (!preferredAccount?.enabled || !preferredAccount?.is_valid) {
      sticky = null;
      preferredAccount = null;
    }
  }

  const pool = preferredAccount ? [preferredAccount] : listValidAccounts();
  const lease = await accountCoordinator.acquireAny(pool, signal);
  markAccountUsed(lease.account.id);

  // create sticky binding if needed
  if (stickyEnabled && clientSid && !sticky) {
    try {
      const sess = await longcatCreateSession(lease.account, {
        agentId: body.agentId || '1',
      });
      const convId = sess.conversationId;
      if (!convId) throw new Error('LongCat session-create returned no conversationId');
      sticky = createSessionRow(
        {
          tenant: req.apiKeyId || 'default',
          model: model || body.model || '',
          sessionId: clientSid,
        },
        lease.account.id,
        convId
      );
    } catch (e) {
      // fallback: no sticky
      sticky = null;
    }
  }

  return { lease, sticky, clientSid };
}

/**
 * Run chat with sticky conversation reuse + compaction.
 */
export async function runChat({
  lease,
  sticky,
  content,
  agentId = '1',
  reasonEnabled = false,
  searchEnabled = false,
  messages = [],
}) {
  const account = lease.account;
  let conversationId = sticky?.conversationId || null;
  let summaryPrefix = '';
  let needsConversationReset = false;

  if (sticky?.shouldCompact && sticky.previousMessages?.length) {
    const summary = compressMessages(sticky.previousMessages);
    summaryPrefix = `[Conversation summary so far]\n${summary}\n\n[Continue]\n`;
    conversationId = null;
    needsConversationReset = true;
    sticky.conversationId = null;
    sticky.shouldCompact = false;
    sticky.summary = summary;
  } else if (sticky?.summary) {
    summaryPrefix = `[Conversation summary so far]\n${sticky.summary}\n\n`;
  }

  const finalContent = summaryPrefix + content;

  let result;
  if (conversationId) {
    try {
      result = await chatCollectWithConversation({
        account,
        content: finalContent,
        conversationId,
        agentId,
        reasonEnabled,
        searchEnabled,
      });
    } catch (e) {
      // conversation may have expired — create a fresh one on same sticky key
      if (/conversation|session|401|403|404/i.test(e.message || '')) {
        const sess = await longcatCreateSession(account, { agentId });
        conversationId = sess.conversationId;
        if (sticky?.key) {
          rotateAfterCompaction(sticky.key, sticky.summary || '', conversationId);
          sticky.conversationId = conversationId;
        }
        result = await chatCollectWithConversation({
          account,
          content: finalContent,
          conversationId,
          agentId,
          reasonEnabled,
          searchEnabled,
        });
      } else {
        throw e;
      }
    }
  } else {
    result = await chatCollect({
      account,
      content: finalContent,
      agentId,
      reasonEnabled,
      searchEnabled,
    });
    conversationId = result.conversationId || null;
    if (needsConversationReset && sticky?.key && conversationId) {
      rotateAfterCompaction(sticky.key, sticky.summary || '', conversationId);
      sticky.conversationId = conversationId;
    }
  }

  if (sticky?.key) {
    const promptTokens = result.usage?.prompt_tokens || Math.ceil(finalContent.length / 4);
    recordSessionUsage(sticky.key, promptTokens);
    const hist = [
      ...(sticky.previousMessages || []),
      { role: 'user', content },
      { role: 'assistant', content: result.text || '' },
    ].slice(-30);
    rememberMessages(sticky.key, hist);
  }

  updateAccount(account.id, { is_valid: true, error_count: 0 });
  return { ...result, conversationId, accountId: account.id, sessionKey: sticky?.key || null };
}
