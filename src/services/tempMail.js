/**
 * Cloudflare Temp Email (dreamhunter2333) client
 * Admin: x-admin-auth | Address JWT: Authorization Bearer
 */

function headers(cfg, { admin = false, jwt = '' } = {}) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (cfg.site_password) h['x-custom-auth'] = cfg.site_password;
  if (admin && cfg.admin_password) h['x-admin-auth'] = cfg.admin_password;
  if (jwt) h.Authorization = `Bearer ${jwt}`;
  return h;
}

function base(cfg) {
  return String(cfg.api_base || '')
    .trim()
    .replace(/\/+$/, '');
}

export function isTempMailConfigured(cfg) {
  return !!(base(cfg) && cfg.admin_password);
}

export async function fetchOpenSettings(cfg) {
  const b = base(cfg);
  if (!b) throw new Error('未配置临时邮箱 API 地址');
  const res = await fetch(`${b}/open_api/settings`, { headers: headers(cfg) });
  if (!res.ok) throw new Error(`读取邮箱配置失败 HTTP ${res.status}`);
  return res.json();
}

export async function listDomains(cfg) {
  const settings = await fetchOpenSettings(cfg);
  const domains = settings.domains || settings.defaultDomains || [];
  return domains.map(String).filter(Boolean);
}

function randomLocal(len = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = alphabet[Math.floor(Math.random() * 26)];
  for (let i = 1; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export async function resolveDomain(cfg, preferred) {
  const domains = await listDomains(cfg);
  if (!domains.length) {
    if (cfg.domain) return cfg.domain;
    if (preferred) return preferred;
    throw new Error('临时邮箱未返回可用域名');
  }
  if (preferred && domains.includes(preferred)) return preferred;
  if (cfg.domain && domains.includes(cfg.domain)) return cfg.domain;
  return domains[Math.floor(Math.random() * domains.length)];
}

export async function createAddress(cfg, { name, domain } = {}) {
  if (!isTempMailConfigured(cfg)) throw new Error('请先配置临时邮箱 API 与管理口令');
  const b = base(cfg);
  const d = await resolveDomain(cfg, domain);
  const local = (name || randomLocal()).toLowerCase();
  const res = await fetch(`${b}/admin/new_address`, {
    method: 'POST',
    headers: headers(cfg, { admin: true }),
    body: JSON.stringify({ name: local, domain: d }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`创建临时邮箱失败 HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const jwt = data.jwt || '';
  const address = data.address || `${local}@${d}`;
  if (!jwt) throw new Error('创建邮箱成功但未返回 JWT');
  return {
    address,
    jwt,
    address_id: data.address_id,
    password: data.password,
  };
}

export async function listParsedMails(cfg, jwt, { limit = 20, offset = 0 } = {}) {
  const b = base(cfg);
  let res = await fetch(
    `${b}/api/parsed_mails?limit=${Math.min(100, limit)}&offset=${Math.max(0, offset)}`,
    { headers: headers(cfg, { jwt }) }
  );
  if (res.status === 404) {
    res = await fetch(
      `${b}/api/mails?limit=${Math.min(100, limit)}&offset=${Math.max(0, offset)}`,
      { headers: headers(cfg, { jwt }) }
    );
  }
  if (!res.ok) throw new Error(`读取邮件失败 HTTP ${res.status}`);
  const data = await res.json();
  return data.results || data.mails || [];
}

const CODE_RE = /(?<![A-Za-z0-9])(\d{4,8})(?![A-Za-z0-9])/;

export function extractCodeFromMail(mail) {
  const blob = [
    mail.subject,
    mail.text,
    mail.html,
    mail.raw,
    mail.source,
  ]
    .map((x) => String(x || ''))
    .join('\n');
  const patterns = [
    /(?:验证码|verification code|code is|code:|码为|码是)[^\d]{0,20}(\d{4,8})/i,
    /(?:安全验证|security)[^\d]{0,40}(\d{4,8})/i,
  ];
  for (const p of patterns) {
    const m = blob.match(p);
    if (m) return m[1];
  }
  const m6 = blob.match(/(?<![A-Za-z0-9])(\d{6})(?![A-Za-z0-9])/);
  if (m6) return m6[1];
  const m = blob.match(CODE_RE);
  return m ? m[1] : null;
}

export async function waitForCode(cfg, jwt, { timeout = 120000, pollInterval = 3000 } = {}) {
  const deadline = Date.now() + timeout;
  const seen = new Set();
  let interval = Math.max(1000, pollInterval);
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const mails = await listParsedMails(cfg, jwt, { limit: 15 });
      for (const mail of mails) {
        const mid = mail.id || mail.message_id || JSON.stringify(mail).slice(0, 40);
        if (seen.has(mid)) continue;
        seen.add(mid);
        const code = extractCodeFromMail(mail);
        if (code) return code;
      }
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(10000, interval * 1.2);
  }
  throw new Error(`等待邮箱验证码超时（${Math.floor(timeout / 1000)}s）${lastErr ? ': ' + lastErr : ''}`);
}

export async function testConnection(cfg) {
  if (!base(cfg)) return { ok: false, error: '请填写 API 地址' };
  try {
    const settings = await fetchOpenSettings(cfg);
    const domains = settings.domains || settings.defaultDomains || [];
    const result = {
      ok: true,
      version: settings.version,
      domains,
      need_auth: settings.needAuth,
      enable_user_create: settings.enableUserCreateEmail,
    };
    if (cfg.admin_password) {
      const addr = await createAddress(cfg);
      result.test_address = addr.address;
      result.has_jwt = !!addr.jwt;
    }
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
