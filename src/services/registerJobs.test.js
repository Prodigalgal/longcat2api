import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('reuses an active registration job and recovers stale jobs', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'longcat2api-register-jobs-'));
  process.env.DATA_DIR = dataDir;
  process.env.CONFIG_PATH = path.join(dataDir, 'config.json');
  process.env.SQLITE_PATH = path.join(dataDir, 'test.db');

  const db = await import('../db/index.js');
  const register = await import('./register.js');
  db.initDb();
  t.after(() => {
    db.closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  db.createRegisterJob({
    id: 'job-running',
    success_target: 2,
    max_attempts: 3,
    concurrent: 1,
  });
  db.appendRegisterLog('job-running', 'started');

  const reused = register.startBatchRegisterJob({ success_target: 5, max_attempts: 5 });
  assert.equal(reused.id, 'job-running');
  assert.equal(reused.reused, true);
  assert.equal(db.getDb().prepare('SELECT count(*) AS count FROM register_jobs').get().count, 1);
  assert.equal(db.getActiveRegisterJob().id, 'job-running');

  const stale = register.getActiveBatchRegisterJob({
    now: Date.now() + 120_000,
    staleMs: 60_000,
  });
  assert.equal(stale, null);
  const expired = db.getRegisterJob('job-running');
  assert.equal(expired.status, 'error');
  assert.match(expired.logs.at(-1).msg, /marked stale/);

  db.createRegisterJob({
    id: 'job-interrupted',
    success_target: 1,
    max_attempts: 1,
    concurrent: 1,
  });
  assert.equal(db.failInterruptedRegisterJobs('service restarted during test'), 1);
  const interrupted = db.getRegisterJob('job-interrupted');
  assert.equal(interrupted.status, 'error');
  assert.match(interrupted.logs.at(-1).msg, /service restarted during test/);
});
