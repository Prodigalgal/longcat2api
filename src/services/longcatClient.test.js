import test from 'node:test';
import assert from 'node:assert/strict';

import { isAuthenticatedUserCurrent, isSessionRateLimit } from './longcatClient.js';

test('rejects code=0 anonymous user-current payloads', () => {
  assert.equal(
    isAuthenticatedUserCurrent({
      code: 0,
      data: { userId: null, email: null, loginStatus: 0, token: null },
    }),
    false
  );
});

test('accepts an authenticated user-current identity', () => {
  assert.equal(
    isAuthenticatedUserCurrent({ code: 0, data: { userId: 'u1', loginStatus: 1 } }),
    true
  );
});

test('classifies only retryable session-create throttling messages', () => {
  assert.equal(isSessionRateLimit('操作太快啦，请稍后再试～'), true);
  assert.equal(isSessionRateLimit('HTTP 429 Too Many Requests'), true);
  assert.equal(isSessionRateLimit('authentication expired'), false);
});
