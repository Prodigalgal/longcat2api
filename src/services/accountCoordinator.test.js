import test from 'node:test';
import assert from 'node:assert/strict';

import { AccountCoordinator } from './accountCoordinator.js';

test('uses different accounts in parallel and dispatches queued work after release', async () => {
  const coordinator = new AccountCoordinator({
    maxPerAccount: 1,
    queueTimeoutMs: 2000,
  });
  const accounts = [{ id: 'a' }, { id: 'b' }];
  const first = await coordinator.acquireAny(accounts);
  const second = await coordinator.acquireAny(accounts);
  assert.notEqual(first.account.id, second.account.id);

  let settled = false;
  const thirdPromise = coordinator.acquireAny(accounts).then((lease) => {
    settled = true;
    return lease;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  first.release();
  const third = await thirdPromise;
  assert.equal(third.account.id, first.account.id);
  second.release();
  third.release();
});

test('aborting one queued request leaves other leases intact', async () => {
  const coordinator = new AccountCoordinator({ maxPerAccount: 1, queueTimeoutMs: 2000 });
  const active = await coordinator.acquire({ id: 'a' });
  const controller = new AbortController();
  const queued = coordinator.acquire({ id: 'a' }, controller.signal);
  controller.abort(new Error('client gone'));
  await assert.rejects(queued, /client gone/);
  assert.equal(coordinator.status().active, 1);
  assert.equal(coordinator.status().queued, 0);
  active.release();
});
