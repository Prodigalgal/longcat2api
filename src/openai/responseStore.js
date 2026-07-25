import { getDb } from '../db/index.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS openai_responses (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  response_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_openai_responses_exp ON openai_responses(expires_at);
`;

let ready = false;

function ensureSchema() {
  if (ready) return;
  getDb().exec(SCHEMA);
  ready = true;
}

function ttlMs() {
  const seconds = Number(process.env.LONGCAT2API_RESPONSE_TTL_SECONDS || 259200);
  return Math.max(3600, Number.isFinite(seconds) ? seconds : 259200) * 1000;
}

function parse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanup() {
  ensureSchema();
  getDb().prepare('DELETE FROM openai_responses WHERE expires_at <= ?').run(Date.now());
}

export function saveResponse({ tenant, response, input }) {
  if (!response?.id) return;
  ensureSchema();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO openai_responses(id, tenant, response_json, input_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         response_json=excluded.response_json, input_json=excluded.input_json,
         expires_at=excluded.expires_at`
    )
    .run(
      response.id,
      tenant || 'default',
      JSON.stringify(response),
      JSON.stringify(input ?? null),
      now,
      now + ttlMs()
    );
}

export function getResponse(id, tenant) {
  cleanup();
  const row = getDb()
    .prepare('SELECT response_json FROM openai_responses WHERE id=? AND tenant=?')
    .get(String(id), tenant || 'default');
  return row ? parse(row.response_json, null) : null;
}

export function deleteResponse(id, tenant) {
  ensureSchema();
  return (
    getDb()
      .prepare('DELETE FROM openai_responses WHERE id=? AND tenant=?')
      .run(String(id), tenant || 'default').changes > 0
  );
}

export function getResponseInputItems(id, tenant) {
  cleanup();
  const row = getDb()
    .prepare('SELECT input_json FROM openai_responses WHERE id=? AND tenant=?')
    .get(String(id), tenant || 'default');
  if (!row) return null;
  const input = parse(row.input_json, null);
  const data = Array.isArray(input)
    ? input
    : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: String(input || '') }] }];
  return {
    object: 'list',
    data,
    first_id: data[0]?.id || null,
    last_id: data.at(-1)?.id || null,
    has_more: false,
  };
}
