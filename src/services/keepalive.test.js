import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldReauthorize } from './keepalive.js';

const recoverable = { email: 'user@example.com', password: 'secret' };

test('reauthorizes an account with credentials and no cookie', () => {
  assert.equal(shouldReauthorize(recoverable, 'no cookie'), true);
});

test('reauthorizes explicit upstream authentication failures', () => {
  assert.equal(
    shouldReauthorize({ ...recoverable, cookie: 'passport_token_key=expired' }, 'auth failed HTTP 401'),
    true
  );
});

test('reauthorizes LongCat Chinese login-required business errors', () => {
  assert.equal(
    shouldReauthorize(
      { ...recoverable, cookie: 'passport_token_key=expired' },
      'session-create failed: 登录后才能继续对话哦~'
    ),
    true
  );
});

test('does not open a browser for a transient network failure', () => {
  assert.equal(
    shouldReauthorize({ ...recoverable, cookie: 'passport_token_key=value' }, 'fetch timed out'),
    false
  );
});

test('reauthorizes through temp mail when a mailbox JWT is missing', () => {
  assert.equal(
    shouldReauthorize(
      { email: 'user@example.com' },
      'auth failed HTTP 401',
      { tempMailConfigured: true }
    ),
    true
  );
});

test('does not attempt recovery without credentials or configured temp mail', () => {
  assert.equal(
    shouldReauthorize(
      { email: 'user@example.com' },
      'auth failed HTTP 401',
      { tempMailConfigured: false }
    ),
    false
  );
});
