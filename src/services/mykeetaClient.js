/**
 * Overseas LongCat auth via passport.mykeeta.com (email OTP).
 *
 * NOT passport.meituan.com (CN phone).
 *
 * Documented flow: docs/LONGCAT_PROTOCOL.md
 *
 * APIs (base https://passport.mykeeta.com):
 *  - POST /api/emaillogin/v1/userriskcheck
 *  - POST /api/emaillogin/v1/emailsignupapply | emailloginapply
 *  - POST /api/emaillogin/v1/emailsignup     | emaillogin
 *  - POST /api/emaillogin/v1/emailpasswordlogin
 *  - callback: https://longcat.chat/api/v1/user-loginV3?url=...
 *
 * Yoda (error 101190 C_USER_LOGIN_YODA_VERIFY) may require slider — automation optional.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';

export const MYKEETA = {
  origin: 'https://passport.mykeeta.com',
  api: 'https://passport.mykeeta.com',
  // LongCat prod constants from frontend
  joinkey: '1101498_851697727',
  tokenId: '5oTEq210UBLUcm4tcuuy6A',
  service: 'consumer',
  region: 'HK',
  cityId: '810001',
  riskCostId: '119801',
  theme: 'longcat',
  locale: 'en',
  longcatLoginV3: 'https://longcat.chat/api/v1/user-loginV3',
};

/** Error codes observed in oversea passport fetch module */
export const MYKEETA_CODES = {
  C_USER_LOGIN_PASSWORD_ERR: 101005,
  C_USER_RISK_DENY: 101135,
  C_USER_HAS_RISK: 101144,
  C_USER_LOGIN_NEED_VERIFY: 101157,
  C_USER_LOGIN_YODA_VERIFY: 101190,
  C_USER_YODA_RISK_HOLDER: 101258,
  C_USER_YODA_DENY_HOLDER: 101259,
  C_USER_YODA_VERIFY_CODE_ERR: 101270,
  C_USER_LOGIN_TO_SIGNUP: 101271,
  C_USER_SIGNUP_TO_LOGIN: 101272,
};

export function buildLoginPageUrl({
  backUrl = 'https://longcat.chat/',
  locale = MYKEETA.locale,
  region = MYKEETA.region,
} = {}) {
  const v3 = `${MYKEETA.longcatLoginV3}?url=${encodeURIComponent(backUrl)}`;
  const u = new URL('/pc/login', MYKEETA.origin);
  u.searchParams.set('locale', locale);
  u.searchParams.set('region', region);
  u.searchParams.set('joinkey', MYKEETA.joinkey);
  u.searchParams.set('token_id', MYKEETA.tokenId);
  u.searchParams.set('service', MYKEETA.service);
  u.searchParams.set('risk_cost_id', MYKEETA.riskCostId);
  u.searchParams.set('theme', MYKEETA.theme);
  u.searchParams.set('cityId', MYKEETA.cityId);
  u.searchParams.set('backurl', v3);
  return u.toString();
}

function headers(extra = {}) {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    origin: MYKEETA.origin,
    referer: `${MYKEETA.origin}/pc/login`,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ...extra,
  };
}

async function pcPost(path, body, { proxyUrl, cookie = '' } = {}) {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const h = headers(cookie ? { cookie } : {});
  const res = await undiciFetch(`${MYKEETA.api}${path}`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body || {}),
    dispatcher,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`mykeeta invalid JSON HTTP ${res.status}: ${text.slice(0, 160)}`);
    err.status = res.status;
    err.raw = text;
    throw err;
  }
  // Collect set-cookie for session continuity
  const setCookie = res.headers.getSetCookie?.() || [];
  return { status: res.status, data, setCookie, headers: res.headers };
}

/**
 * Step 1: risk check — may return user_ticket or Yoda challenge.
 * Body shape varies; callers should log raw `data` when reverse-engineering live.
 */
export async function userRiskCheck(email, opts = {}) {
  return pcPost(
    '/api/emaillogin/v1/userriskcheck',
    {
      email: String(email || '').trim(),
      // region / service often required by interceptor middleware
      region: opts.region || MYKEETA.region,
      joinkey: MYKEETA.joinkey,
      token_id: MYKEETA.tokenId,
      service: MYKEETA.service,
    },
    opts
  );
}

/** Step 2 login: send email OTP (needs user_ticket from risk check / prior step) */
export async function emailLoginApply({ user_ticket, request_code, response_code }, opts = {}) {
  const body = { user_ticket };
  if (request_code) body.request_code = request_code;
  if (response_code) body.response_code = response_code;
  return pcPost('/api/emaillogin/v1/emailloginapply', body, opts);
}

/** Step 2 signup: send email OTP for new account */
export async function emailSignupApply(
  { username = '', user_ticket = '', password = '', request_code, response_code },
  opts = {}
) {
  const body = { username, user_ticket, password };
  if (request_code) body.request_code = request_code;
  if (response_code) body.response_code = response_code;
  return pcPost('/api/emaillogin/v1/emailsignupapply', body, opts);
}

/** Step 3 login with OTP */
export async function emailLogin(
  { user_ticket, email_code, serial_number, set_cookie = true },
  opts = {}
) {
  return pcPost(
    '/api/emaillogin/v1/emaillogin',
    {
      user_ticket,
      email_code: String(email_code || '').trim(),
      serial_number,
      set_cookie: !!set_cookie,
    },
    opts
  );
}

/** Step 3 signup with OTP */
export async function emailSignup(body, opts = {}) {
  return pcPost('/api/emaillogin/v1/emailsignup', body, opts);
}

export async function emailPasswordLogin(body, opts = {}) {
  return pcPost('/api/emaillogin/v1/emailpasswordlogin', body, opts);
}

/**
 * After passport sets cookies, exchange into longcat.chat session via user-loginV3.
 * `cookieHeader` should be the Cookie string from mykeeta Set-Cookie (passport domain).
 * Returns longcat Set-Cookie / body for storing passport_token_key.
 */
export async function exchangeLongcatLoginV3({
  cookieHeader = '',
  continueUrl = 'https://longcat.chat/',
  proxyUrl,
} = {}) {
  const url = `${MYKEETA.longcatLoginV3}?url=${encodeURIComponent(continueUrl)}`;
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const res = await undiciFetch(url, {
    method: 'GET',
    headers: {
      accept: 'text/html,application/json',
      cookie: cookieHeader,
      referer: MYKEETA.origin,
      'user-agent': headers()['user-agent'],
    },
    dispatcher,
    redirect: 'manual',
  });
  const text = await res.text();
  const setCookie = res.headers.getSetCookie?.() || [];
  return {
    status: res.status,
    location: res.headers.get('location') || '',
    setCookie,
    body: text.slice(0, 500),
  };
}

/**
 * Detect Yoda challenge in API response.
 * @returns {{ needYoda: boolean, requestCode?: string, code?: number, raw: any }}
 */
export function detectYoda(data) {
  const err = data?.error || data;
  const code = err?.code ?? data?.code;
  const need =
    code === MYKEETA_CODES.C_USER_LOGIN_YODA_VERIFY ||
    code === MYKEETA_CODES.C_USER_YODA_RISK_HOLDER ||
    code === MYKEETA_CODES.C_USER_LOGIN_NEED_VERIFY;
  const requestCode = err?.data?.requestCode || err?.data?.request_code || data?.data?.requestCode;
  return { needYoda: !!need, requestCode, code, raw: data };
}

export function summarizeFlow() {
  return {
    passport: MYKEETA.origin,
    login_page: buildLoginPageUrl(),
    steps: [
      'userriskcheck(email) → user_ticket | yoda',
      'emailsignupapply|emailloginapply(user_ticket) → serial_number | yoda',
      'read OTP from temp mail',
      'emailsignup|emaillogin(user_ticket, email_code, serial_number)',
      'user-loginV3 → longcat passport_token_key cookie',
      'session-create + chat-completion-V2 (reasonEnabled/searchEnabled)',
    ],
    chat_flags: {
      reasonEnabled: '0|1 thinking on/off (no low/medium/high)',
      searchEnabled: '0|1 web search on/off',
      agentId: '1 default text, 2 pro-like alias',
    },
    keepalive: 'POST /api/v1/session-create with Cookie',
  };
}
