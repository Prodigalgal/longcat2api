import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'longcat-session-test-'));
process.env.SQLITE_PATH = path.join(temp, 'sessions.db');
process.env.DATA_DIR = temp;
process.env.LONGCAT2API_SESSION_COMPACT_THRESHOLD_TOKENS = '8000';

const db = await import('../db/index.js');
const sessions = await import('./sessionStore.js');
db.initDb();

after(() => {
  db.closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('persists sticky account and upstream conversation identity', () => {
  const input = { tenant: 'tenant-a', model: 'longcat-flash', sessionId: 'client-1' };
  sessions.createSessionRow(input, 'account-a', 'conversation-real-1');
  const found = sessions.findSession(input);
  assert.equal(found.accountId, 'account-a');
  assert.equal(found.conversationId, 'conversation-real-1');
});

test('links previous_response_id to the same sticky session', () => {
  const input = { tenant: 'tenant-a', model: 'longcat-flash', sessionId: 'response-chain' };
  const sticky = sessions.createSessionRow(input, 'account-b', 'conversation-real-2');
  sessions.linkResponseToSession('resp_123', sticky.key);
  const found = sessions.findSessionByResponseId('resp_123');
  assert.equal(found.accountId, 'account-b');
  assert.equal(found.conversationId, 'conversation-real-2');
});

test('compaction rotation stores the real upstream conversation id', () => {
  const input = { tenant: 'tenant-a', model: 'longcat-flash', sessionId: 'compact' };
  const sticky = sessions.createSessionRow(input, 'account-c', 'conversation-old');
  sessions.rememberMessages(sticky.key, [{ role: 'user', content: 'prior context' }]);
  sessions.recordSessionUsage(sticky.key, 9000);
  assert.equal(sessions.findSession(input).shouldCompact, true);

  sessions.rotateAfterCompaction(sticky.key, 'summary', 'conversation-from-longcat');
  const found = sessions.findSession(input);
  assert.equal(found.conversationId, 'conversation-from-longcat');
  assert.equal(found.summary, 'summary');
  assert.equal(found.promptTokens, 0);
});

test('packed state round-trips without exposing raw JSON', () => {
  const packed = sessions.packState({ session: 'abc', account: 'a' });
  assert.match(packed, /^lc1\./);
  assert.deepEqual(sessions.unpackState(packed), { session: 'abc', account: 'a' });
});
