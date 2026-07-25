import { initDb, getAccount, updateAccount, closeDb } from '../src/db/index.js';
import { renewOneAccount } from '../src/services/keepalive.js';
import { stopProxy } from '../src/services/proxyPool.js';

const accountId = String(process.env.LONGCAT2API_ACCOUNT_ID || '').trim();
if (!accountId) {
  console.error('LONGCAT2API_ACCOUNT_ID is required');
  process.exit(2);
}

initDb();
let backup = null;
try {
  let before = getAccount(accountId);
  if (!before) throw new Error(`account not found: ${accountId}`);
  if (process.env.LONGCAT2API_FORCE_EXPIRE_FOR_TEST === '1') {
    backup = {
      cookie: before.cookie,
      passport_token: before.passport_token,
      lxsdk_cuid: before.lxsdk_cuid,
      lxsdk_s: before.lxsdk_s,
      enabled: before.enabled,
      is_valid: before.is_valid,
      error_count: before.error_count,
      renew_error: before.renew_error,
    };
    updateAccount(accountId, {
      cookie: 'passport_token_key=expired_acceptance_token',
      passport_token: 'expired_acceptance_token',
      enabled: false,
      is_valid: false,
      renew_error: 'forced inactive acceptance fixture',
    });
    before = getAccount(accountId);
    console.log('[reauthorize-once] injected inactive acceptance fixture');
  }
  console.log(`[reauthorize-once] starting id=${accountId}`);
  const result = await renewOneAccount(before);
  const after = getAccount(accountId);
  const acceptance = {
    ok: result.ok,
    reauthorized: result.reauthorized === true,
    detail: result.detail || '',
    enabled: Boolean(after?.enabled),
    is_valid: Boolean(after?.is_valid),
    error_count: after?.error_count,
    token_rotated: Boolean(
      after?.passport_token && after.passport_token !== before.passport_token
    ),
    renew_error: after?.renew_error || '',
  };
  console.log(`[reauthorize-once] result=${JSON.stringify(acceptance)}`);
  process.exitCode =
    acceptance.ok &&
    acceptance.reauthorized &&
    acceptance.enabled &&
    acceptance.is_valid &&
    acceptance.token_rotated
      ? 0
      : 2;
  if (process.exitCode && backup) {
    updateAccount(accountId, backup);
    console.log('[reauthorize-once] restored previous valid session after failed acceptance');
  }
} catch (error) {
  if (backup) {
    updateAccount(accountId, backup);
    console.log('[reauthorize-once] restored previous valid session after exception');
  }
  throw error;
} finally {
  closeDb();
  await stopProxy().catch(() => {});
}
