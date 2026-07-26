import test from 'node:test';
import assert from 'node:assert/strict';

import { refreshAddressJwt } from './tempMail.js';

const config = {
  api_base: 'https://mail.example.test',
  admin_password: 'admin-test-token',
};

test('refreshes an existing address JWT through the admin API', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/admin/address?')) {
      return Response.json({
        results: [
          { id: 3, name: 'other', address: 'other@example.com' },
          { id: 7, name: 'user', address: 'user@example.com' },
        ],
      });
    }
    if (String(url).endsWith('/admin/show_password/7')) {
      return Response.json({ jwt: 'renewed.test.jwt' });
    }
    return new Response('not found', { status: 404 });
  };

  const result = await refreshAddressJwt(config, ' User@Example.com ');

  assert.deepEqual(result, {
    jwt: 'renewed.test.jwt',
    address: 'user@example.com',
    address_id: 7,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/admin\/address\?/);
  assert.equal(new URL(calls[0].url).searchParams.get('query'), 'user@example.com');
  assert.equal(calls[0].options.headers['x-admin-auth'], 'admin-test-token');
  assert.equal(calls[1].url, 'https://mail.example.test/admin/show_password/7');
});

test('does not accept a partial mailbox match', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    Response.json({ results: [{ id: 8, address: 'user-plus@example.com' }] });

  await assert.rejects(
    refreshAddressJwt(config, 'user@example.com'),
    /临时邮箱不存在/
  );
});

test('rejects an invalid account email before making a request', async () => {
  await assert.rejects(refreshAddressJwt(config, 'not-an-email'), /邮箱格式无效/);
});
