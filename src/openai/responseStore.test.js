import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'longcat-response-test-'));
process.env.SQLITE_PATH = path.join(temp, 'responses.db');
process.env.DATA_DIR = temp;

const db = await import('../db/index.js');
const store = await import('./responseStore.js');
db.initDb();

after(() => {
  db.closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('stores, retrieves, and deletes responses within one API-key tenant', () => {
  const response = { id: 'resp_1', object: 'response', status: 'completed', output: [] };
  store.saveResponse({ tenant: 'tenant-a', response, input: 'hello' });
  assert.deepEqual(store.getResponse('resp_1', 'tenant-a'), response);
  assert.equal(store.getResponse('resp_1', 'tenant-b'), null);

  const items = store.getResponseInputItems('resp_1', 'tenant-a');
  assert.equal(items.object, 'list');
  assert.equal(items.data[0].content[0].text, 'hello');
  assert.equal(store.deleteResponse('resp_1', 'tenant-a'), true);
  assert.equal(store.getResponse('resp_1', 'tenant-a'), null);
});
