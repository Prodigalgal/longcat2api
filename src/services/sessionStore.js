/**
 * Sticky conversation sessions: same client session_id → same account + conversationId.
 * Optional compaction when prompt tokens exceed threshold.
 */

import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { getDb } from '../db/index.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_sessions (
  session_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  messages_json TEXT NOT NULL DEFAULT '[]',
  summary_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_sess_exp ON conversation_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_conv_sess_acc ON conversation_sessions(account_id);
CREATE TABLE IF NOT EXISTS response_session_links (
  response_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_response_link_exp ON response_session_links(expires_at);
`;

let schemaReady = false;

function ensureSchema() {
  if (schemaReady) return;
  getDb().exec(SCHEMA);
  schemaReady = true;
}

function ttlMs() {
  const sec = Number(process.env.LONGCAT2API_SESSION_TTL_SECONDS || 259200);
  return Math.max(3600, Number.isFinite(sec) ? sec : 259200) * 1000;
}

function compactThreshold() {
  const n = Number(process.env.LONGCAT2API_SESSION_COMPACT_THRESHOLD_TOKENS || 80000);
  return Math.max(8000, Number.isFinite(n) ? n : 80000);
}

export function sessionKey({ tenant = 'default', model = '', sessionId = '' }) {
  return createHash('sha256')
    .update(`${tenant}\0${model}\0${sessionId}`)
    .digest('hex');
}

export function newConversationId() {
  return randomUUID().replace(/-/g, '');
}

function parseMessages(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function cleanupSessions() {
  ensureSchema();
  const removed = getDb()
    .prepare('DELETE FROM conversation_sessions WHERE expires_at <= ?')
    .run(Date.now()).changes;
  getDb().prepare('DELETE FROM response_session_links WHERE expires_at <= ?').run(Date.now());
  return removed;
}

function sessionFromRow(row) {
  if (!row) return null;
  return {
    key: row.session_key,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    model: row.model,
    promptTokens: row.prompt_tokens,
    previousMessages: parseMessages(row.messages_json),
    summary: row.summary_text || '',
    shouldCompact: row.prompt_tokens >= compactThreshold(),
  };
}

/**
 * Find sticky session or null.
 */
export function findSession(input) {
  ensureSchema();
  cleanupSessions();
  const key = sessionKey(input);
  const row = getDb()
    .prepare(
      `SELECT * FROM conversation_sessions WHERE session_key = ? AND expires_at > ?`
    )
    .get(key, Date.now());
  if (!row) return null;
  touchSession(key);
  return sessionFromRow(row);
}

export function findSessionByResponseId(responseId) {
  ensureSchema();
  cleanupSessions();
  const row = getDb()
    .prepare(
      `SELECT s.* FROM response_session_links l
       JOIN conversation_sessions s ON s.session_key = l.session_key
       WHERE l.response_id = ? AND l.expires_at > ? AND s.expires_at > ?`
    )
    .get(String(responseId || ''), Date.now(), Date.now());
  if (!row) return null;
  touchSession(row.session_key);
  return sessionFromRow(row);
}

export function linkResponseToSession(responseId, key) {
  if (!responseId || !key) return;
  ensureSchema();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO response_session_links(response_id, session_key, created_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(response_id) DO UPDATE SET
         session_key=excluded.session_key, expires_at=excluded.expires_at`
    )
    .run(String(responseId), key, now, now + ttlMs());
}

export function createSessionRow(input, accountId, conversationId) {
  ensureSchema();
  const key = sessionKey(input);
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO conversation_sessions(
        session_key, account_id, conversation_id, model, prompt_tokens,
        messages_json, summary_text, created_at, last_used_at, expires_at
      ) VALUES (?, ?, ?, ?, 0, '[]', '', ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        account_id=excluded.account_id,
        conversation_id=excluded.conversation_id,
        model=excluded.model,
        prompt_tokens=0,
        messages_json='[]',
        summary_text='',
        last_used_at=excluded.last_used_at,
        expires_at=excluded.expires_at`
    )
    .run(key, accountId, conversationId, input.model || '', now, now, now + ttlMs());
  return {
    key,
    accountId,
    conversationId,
    model: input.model || '',
    promptTokens: 0,
    previousMessages: [],
    summary: '',
    shouldCompact: false,
  };
}

function touchSession(key) {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE conversation_sessions SET last_used_at=?, expires_at=? WHERE session_key=?`
    )
    .run(now, now + ttlMs(), key);
}

export function recordSessionUsage(key, promptTokens) {
  if (!key || !Number.isFinite(promptTokens) || promptTokens <= 0) return;
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE conversation_sessions SET
        prompt_tokens = prompt_tokens + ?, last_used_at=?, expires_at=?
       WHERE session_key=?`
    )
    .run(Math.floor(promptTokens), now, now + ttlMs(), key);
}

export function rememberMessages(key, messages) {
  if (!key) return;
  const json = JSON.stringify((messages || []).slice(-40));
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE conversation_sessions SET messages_json=?, last_used_at=?, expires_at=? WHERE session_key=?`
    )
    .run(json, now, now + ttlMs(), key);
}

/**
 * After compaction: new conversationId, keep summary, reset tokens.
 */
export function rotateAfterCompaction(key, summary, conversationId = newConversationId()) {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE conversation_sessions SET
        conversation_id=?, prompt_tokens=0, messages_json='[]',
        summary_text=?, last_used_at=?, expires_at=?
       WHERE session_key=?`
    )
    .run(conversationId, String(summary || '').slice(0, 12000), now, now + ttlMs(), key);
  return conversationId;
}

export function sessionStats() {
  ensureSchema();
  cleanupSessions();
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(prompt_tokens),0) AS tokens
       FROM conversation_sessions WHERE expires_at > ?`
    )
    .get(Date.now());
  return {
    active_sessions: row?.n || 0,
    total_prompt_tokens: row?.tokens || 0,
    ttl_seconds: Math.floor(ttlMs() / 1000),
    compact_threshold_tokens: compactThreshold(),
  };
}

/** Lightweight message history compression for sticky context */
export function compressMessages(messages, maxChars = 12000) {
  const arr = Array.isArray(messages) ? messages : [];
  let text = arr
    .map((m) => {
      const role = m.role || 'user';
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      return `${role}: ${c}`;
    })
    .join('\n');
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.floor(maxChars * 0.35)) + '\n…\n' + text.slice(-Math.floor(maxChars * 0.55));
}

/** Optional binary pack for previous_response_id style state */
export function packState(obj) {
  const raw = deflateSync(Buffer.from(JSON.stringify(obj)));
  return `lc1.${raw.toString('base64url')}`;
}

export function unpackState(token) {
  if (!token || !String(token).startsWith('lc1.')) return null;
  try {
    const buf = Buffer.from(String(token).slice(4), 'base64url');
    return JSON.parse(inflateSync(buf).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Build sticky session id from OpenAI request headers / body.
 */
export function extractClientSessionId(req, body = {}) {
  return (
    body.session_id ||
    body.user ||
    body.conversation?.id ||
    (typeof body.conversation === 'string' ? body.conversation : '') ||
    req.headers['x-session-id'] ||
    req.headers['x-client-request-id'] ||
    ''
  );
}
