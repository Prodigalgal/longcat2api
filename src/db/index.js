import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  cookie TEXT NOT NULL DEFAULT '',
  passport_token TEXT NOT NULL DEFAULT '',
  lxsdk_cuid TEXT NOT NULL DEFAULT '',
  lxsdk_s TEXT NOT NULL DEFAULT '',
  mail_jwt TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  is_valid INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  last_test_at INTEGER,
  last_renew_at INTEGER,
  renew_error TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_stats (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  account_id TEXT,
  model TEXT,
  mode TEXT,
  stream INTEGER,
  status INTEGER,
  latency_ms INTEGER,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  path TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS register_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  success_target INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  concurrent INTEGER NOT NULL DEFAULT 1,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  logs TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_accounts_enabled ON accounts(enabled, is_valid);
CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at DESC);
`;

export function initDb() {
  fs.mkdirSync(path.dirname(paths.sqlite), { recursive: true });
  db = new Database(paths.sqlite);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function getDb() {
  if (!db) initDb();
  return db;
}

// ─── accounts ───────────────────────────────────────────────

export function listAccounts({ includeSecrets = false } = {}) {
  const rows = getDb().prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
  return rows.map((r) => sanitizeAccount(r, includeSecrets));
}

export function getAccount(id) {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function insertAccount(acc) {
  const now = Date.now();
  const row = {
    id: acc.id,
    name: acc.name || '',
    email: acc.email || '',
    password: acc.password || '',
    cookie: acc.cookie || '',
    passport_token: acc.passport_token || '',
    lxsdk_cuid: acc.lxsdk_cuid || '',
    lxsdk_s: acc.lxsdk_s || '',
    mail_jwt: acc.mail_jwt || '',
    region: acc.region || '',
    enabled: acc.enabled !== false ? 1 : 0,
    auto_renew: acc.auto_renew !== false ? 1 : 0,
    is_valid: acc.is_valid ? 1 : 0,
    error_count: acc.error_count || 0,
    last_used_at: acc.last_used_at || null,
    last_test_at: acc.last_test_at || null,
    last_renew_at: acc.last_renew_at || null,
    renew_error: acc.renew_error || '',
    note: acc.note || '',
    created_at: now,
    updated_at: now,
  };
  getDb()
    .prepare(
      `INSERT INTO accounts (
        id, name, email, password, cookie, passport_token, lxsdk_cuid, lxsdk_s,
        mail_jwt, region, enabled, auto_renew, is_valid, error_count,
        last_used_at, last_test_at, last_renew_at, renew_error, note, created_at, updated_at
      ) VALUES (
        @id, @name, @email, @password, @cookie, @passport_token, @lxsdk_cuid, @lxsdk_s,
        @mail_jwt, @region, @enabled, @auto_renew, @is_valid, @error_count,
        @last_used_at, @last_test_at, @last_renew_at, @renew_error, @note, @created_at, @updated_at
      )`
    )
    .run(row);
  return getAccount(row.id);
}

export function updateAccount(id, patch) {
  const prev = getAccount(id);
  if (!prev) return null;
  const next = {
    ...prev,
    ...patch,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : prev.enabled,
    auto_renew: patch.auto_renew !== undefined ? (patch.auto_renew ? 1 : 0) : prev.auto_renew,
    is_valid: patch.is_valid !== undefined ? (patch.is_valid ? 1 : 0) : prev.is_valid,
    updated_at: Date.now(),
  };
  getDb()
    .prepare(
      `UPDATE accounts SET
        name=@name, email=@email, password=@password, cookie=@cookie,
        passport_token=@passport_token, lxsdk_cuid=@lxsdk_cuid, lxsdk_s=@lxsdk_s,
        mail_jwt=@mail_jwt, region=@region, enabled=@enabled, auto_renew=@auto_renew,
        is_valid=@is_valid, error_count=@error_count, last_used_at=@last_used_at,
        last_test_at=@last_test_at, last_renew_at=@last_renew_at, renew_error=@renew_error,
        note=@note, updated_at=@updated_at
      WHERE id=@id`
    )
    .run(next);
  return getAccount(id);
}

export function deleteAccount(id) {
  return getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

export function pickAccountRoundRobin() {
  const rows = getDb()
    .prepare(
      `SELECT * FROM accounts
       WHERE enabled = 1 AND is_valid = 1 AND (cookie != '' OR passport_token != '')
       ORDER BY COALESCE(last_used_at, 0) ASC, error_count ASC
       LIMIT 1`
    )
    .all();
  if (!rows.length) return null;
  const acc = rows[0];
  updateAccount(acc.id, { last_used_at: Date.now() });
  return getAccount(acc.id);
}

export function listKeepaliveAccounts() {
  return getDb()
    .prepare(
      `SELECT * FROM accounts WHERE enabled = 1 AND auto_renew = 1 AND (cookie != '' OR passport_token != '')`
    )
    .all();
}

export function sanitizeAccount(row, includeSecrets = false) {
  if (!row) return null;
  const mask = (s) => {
    if (!s) return '';
    if (s.length <= 10) return '***';
    return `${s.slice(0, 6)}***${s.slice(-4)}`;
  };
  const base = {
    id: row.id,
    name: row.name,
    email: row.email,
    region: row.region,
    enabled: !!row.enabled,
    auto_renew: !!row.auto_renew,
    is_valid: !!row.is_valid,
    error_count: row.error_count,
    last_used_at: row.last_used_at,
    last_test_at: row.last_test_at,
    last_renew_at: row.last_renew_at,
    renew_error: row.renew_error,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_cookie: !!(row.cookie || row.passport_token),
    has_password: !!row.password,
    has_mail_jwt: !!row.mail_jwt,
    cookie_masked: mask(row.cookie || row.passport_token),
  };
  if (includeSecrets) {
    base.cookie = row.cookie;
    base.passport_token = row.passport_token;
    base.lxsdk_cuid = row.lxsdk_cuid;
    base.lxsdk_s = row.lxsdk_s;
    base.password = row.password;
    base.mail_jwt = row.mail_jwt;
  }
  return base;
}

export function accountCookieHeader(acc) {
  if (!acc) return '';
  if (acc.cookie && acc.cookie.includes('=')) return acc.cookie;
  const parts = [];
  if (acc.lxsdk_cuid) parts.push(`_lxsdk_cuid=${acc.lxsdk_cuid}`);
  if (acc.passport_token) parts.push(`passport_token_key=${acc.passport_token}`);
  if (acc.lxsdk_s) parts.push(`_lxsdk_s=${acc.lxsdk_s}`);
  if (acc.cookie && !parts.length) return acc.cookie;
  return parts.join('; ');
}

// ─── usage / logs ───────────────────────────────────────────

export function addUsage({ prompt = 0, completion = 0 } = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const total = prompt + completion;
  getDb()
    .prepare(
      `INSERT INTO usage_stats(day, requests, prompt_tokens, completion_tokens, total_tokens)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         requests = requests + 1,
         prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens,
         total_tokens = total_tokens + excluded.total_tokens`
    )
    .run(day, prompt, completion, total);
}

export function getUsage(days = 30) {
  return getDb()
    .prepare('SELECT * FROM usage_stats ORDER BY day DESC LIMIT ?')
    .all(days);
}

export function addRequestLog(entry) {
  getDb()
    .prepare(
      `INSERT INTO request_logs(
        created_at, account_id, model, mode, stream, status, latency_ms,
        prompt_tokens, completion_tokens, error, path
      ) VALUES (
        @created_at, @account_id, @model, @mode, @stream, @status, @latency_ms,
        @prompt_tokens, @completion_tokens, @error, @path
      )`
    )
    .run({
      created_at: Date.now(),
      account_id: entry.account_id || null,
      model: entry.model || '',
      mode: entry.mode || '',
      stream: entry.stream ? 1 : 0,
      status: entry.status || 200,
      latency_ms: entry.latency_ms || 0,
      prompt_tokens: entry.prompt_tokens || 0,
      completion_tokens: entry.completion_tokens || 0,
      error: entry.error || '',
      path: entry.path || '',
    });
  // trim old logs (keep 2000)
  getDb()
    .prepare(
      `DELETE FROM request_logs WHERE id NOT IN (
         SELECT id FROM request_logs ORDER BY id DESC LIMIT 2000
       )`
    )
    .run();
}

export function listRequestLogs(limit = 100) {
  return getDb()
    .prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT ?')
    .all(limit);
}

// ─── register jobs ──────────────────────────────────────────

export function createRegisterJob(job) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO register_jobs(
        id, status, success_target, max_attempts, concurrent,
        success_count, fail_count, attempt_count, logs, created_at, updated_at
      ) VALUES (
        @id, @status, @success_target, @max_attempts, @concurrent,
        0, 0, 0, '[]', @created_at, @updated_at
      )`
    )
    .run({
      id: job.id,
      status: 'running',
      success_target: job.success_target || 1,
      max_attempts: job.max_attempts || 5,
      concurrent: job.concurrent || 1,
      created_at: now,
      updated_at: now,
    });
  return getRegisterJob(job.id);
}

export function getRegisterJob(id) {
  const row = getDb().prepare('SELECT * FROM register_jobs WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    logs: safeJson(row.logs, []),
  };
}

export function appendRegisterLog(id, line) {
  const job = getRegisterJob(id);
  if (!job) return;
  const logs = [...(job.logs || []), { t: Date.now(), msg: String(line) }].slice(-200);
  getDb()
    .prepare(
      `UPDATE register_jobs SET logs = ?, updated_at = ? WHERE id = ?`
    )
    .run(JSON.stringify(logs), Date.now(), id);
}

export function patchRegisterJob(id, patch) {
  const job = getRegisterJob(id);
  if (!job) return null;
  const next = {
    status: patch.status ?? job.status,
    success_count: patch.success_count ?? job.success_count,
    fail_count: patch.fail_count ?? job.fail_count,
    attempt_count: patch.attempt_count ?? job.attempt_count,
    finished_at: patch.finished_at ?? job.finished_at,
    updated_at: Date.now(),
  };
  getDb()
    .prepare(
      `UPDATE register_jobs SET
        status=@status, success_count=@success_count, fail_count=@fail_count,
        attempt_count=@attempt_count, finished_at=@finished_at, updated_at=@updated_at
      WHERE id=@id`
    )
    .run({ id, ...next });
  return getRegisterJob(id);
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
