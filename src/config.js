import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, 'data');

const CONFIG_PATH = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : process.env.LONGCAT2API_CONFIG_FILE
    ? path.resolve(process.env.LONGCAT2API_CONFIG_FILE)
    : path.join(DATA_DIR, 'config.json');

const SQLITE_PATH = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.join(DATA_DIR, 'longcat2api.db');

function env(name, fallback) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') return fallback;
  return String(v).trim();
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());
}

function envInt(name, fallback, lo, hi) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function defaultSettings() {
  return {
    api_keys: env('LONGCAT2API_API_KEYS', env('API_KEYS', 'sk-longcat')),
    admin_password: env('LONGCAT2API_ADMIN_PASSWORD', env('ADMIN_PASSWORD', 'admin')),
    // session = logged-in cookie pool only (no guest oversea chat)
    default_mode: env('LONGCAT2API_DEFAULT_MODE', env('DEFAULT_MODE', 'session')),
    keepalive_interval_seconds: envInt(
      'LONGCAT2API_KEEPALIVE_INTERVAL_SECONDS',
      envInt('KEEPALIVE_INTERVAL_SECONDS', 21600, 300, 604800),
      300,
      604800
    ),
    temp_mail: {
      api_base: '',
      admin_password: '',
      domain: '',
      site_password: '',
      batch_count: 5,
      success_target: 3,
      concurrent: 1,
      concurrent_interval: 3.0,
      otp_timeout: 120,
    },
    proxy_pool: {
      enabled: false,
      sub_url: '',
      listen_port: 17890,
      singbox_path: '',
      rotate_every: 1,
      refresh_interval: 3600,
      connect_retries: 5,
      fetch_sub_each_time: true,
    },
  };
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k]) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** K8s Secret / env always wins over config.json */
export function applyEnvOverrides(data) {
  const d = data || defaultSettings();

  if (process.env.LONGCAT2API_API_KEYS != null || process.env.API_KEYS != null) {
    d.api_keys = env('LONGCAT2API_API_KEYS', env('API_KEYS', d.api_keys));
  }
  if (process.env.LONGCAT2API_ADMIN_PASSWORD != null || process.env.ADMIN_PASSWORD != null) {
    d.admin_password = env(
      'LONGCAT2API_ADMIN_PASSWORD',
      env('ADMIN_PASSWORD', d.admin_password)
    );
  }
  if (process.env.LONGCAT2API_DEFAULT_MODE != null || process.env.DEFAULT_MODE != null) {
    d.default_mode = env('LONGCAT2API_DEFAULT_MODE', env('DEFAULT_MODE', d.default_mode));
  }
  if (
    process.env.LONGCAT2API_KEEPALIVE_INTERVAL_SECONDS != null ||
    process.env.KEEPALIVE_INTERVAL_SECONDS != null
  ) {
    d.keepalive_interval_seconds = envInt(
      'LONGCAT2API_KEEPALIVE_INTERVAL_SECONDS',
      envInt('KEEPALIVE_INTERVAL_SECONDS', d.keepalive_interval_seconds, 300, 604800),
      300,
      604800
    );
  }

  const tm = d.temp_mail || {};
  if (process.env.LONGCAT2API_TEMP_MAIL_API_BASE != null) {
    tm.api_base = env('LONGCAT2API_TEMP_MAIL_API_BASE', '');
  }
  if (process.env.LONGCAT2API_TEMP_MAIL_ADMIN_PASSWORD != null) {
    tm.admin_password = env('LONGCAT2API_TEMP_MAIL_ADMIN_PASSWORD', '');
  }
  if (process.env.LONGCAT2API_TEMP_MAIL_SITE_PASSWORD != null) {
    tm.site_password = env('LONGCAT2API_TEMP_MAIL_SITE_PASSWORD', '');
  }
  if (process.env.LONGCAT2API_TEMP_MAIL_DOMAIN != null) {
    tm.domain = env('LONGCAT2API_TEMP_MAIL_DOMAIN', '');
  }
  if (process.env.LONGCAT2API_REGISTER_BATCH_COUNT != null) {
    tm.batch_count = envInt('LONGCAT2API_REGISTER_BATCH_COUNT', tm.batch_count || 5, 1, 50);
  }
  if (process.env.LONGCAT2API_REGISTER_SUCCESS_TARGET != null) {
    tm.success_target = envInt(
      'LONGCAT2API_REGISTER_SUCCESS_TARGET',
      tm.success_target || 3,
      0,
      50
    );
  }
  if (process.env.LONGCAT2API_REGISTER_CONCURRENT != null) {
    tm.concurrent = envInt('LONGCAT2API_REGISTER_CONCURRENT', tm.concurrent || 1, 1, 10);
  }
  if (process.env.LONGCAT2API_REGISTER_OTP_TIMEOUT != null) {
    tm.otp_timeout = envInt('LONGCAT2API_REGISTER_OTP_TIMEOUT', tm.otp_timeout || 120, 30, 600);
  }
  d.temp_mail = tm;

  const pp = d.proxy_pool || {};
  if (process.env.LONGCAT2API_PROXY_ENABLED != null) {
    pp.enabled = envBool('LONGCAT2API_PROXY_ENABLED', false);
  }
  if (process.env.LONGCAT2API_PROXY_SUB_URL != null) {
    pp.sub_url = env('LONGCAT2API_PROXY_SUB_URL', '');
  }
  if (process.env.LONGCAT2API_PROXY_LISTEN_PORT != null) {
    pp.listen_port = envInt('LONGCAT2API_PROXY_LISTEN_PORT', 17890, 1024, 65535);
  }
  if (process.env.LONGCAT2API_PROXY_SINGBOX_PATH != null) {
    pp.singbox_path = env('LONGCAT2API_PROXY_SINGBOX_PATH', '');
  }
  if (process.env.LONGCAT2API_PROXY_CONNECT_RETRIES != null) {
    pp.connect_retries = envInt('LONGCAT2API_PROXY_CONNECT_RETRIES', 5, 1, 20);
  }
  if (process.env.LONGCAT2API_PROXY_FETCH_SUB_EACH_TIME != null) {
    pp.fetch_sub_each_time = envBool('LONGCAT2API_PROXY_FETCH_SUB_EACH_TIME', true);
  }
  if (process.env.LONGCAT2API_PROXY_REFRESH_INTERVAL != null) {
    pp.refresh_interval = envInt('LONGCAT2API_PROXY_REFRESH_INTERVAL', 3600, 0, 604800);
  }
  d.proxy_pool = pp;
  return d;
}

class ConfigStore {
  constructor() {
    this.path = CONFIG_PATH;
    this.data = defaultSettings();
    this.load();
  }

  ensureDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  load() {
    this.ensureDirs();
    if (!fs.existsSync(this.path)) {
      const example = path.join(ROOT_DIR, 'config.example.json');
      if (fs.existsSync(example)) {
        try {
          const raw = JSON.parse(fs.readFileSync(example, 'utf8'));
          this.data = deepMerge(defaultSettings(), raw);
        } catch {
          this.data = defaultSettings();
        }
      } else {
        this.data = defaultSettings();
      }
      this.data = applyEnvOverrides(this.data);
      this.save();
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.data = applyEnvOverrides(deepMerge(defaultSettings(), raw));
    } catch (e) {
      console.error('[config] load failed:', e.message);
      this.data = applyEnvOverrides(defaultSettings());
    }
  }

  save() {
    this.ensureDirs();
    // Persist file values only (env still wins on next load)
    const toWrite = { ...this.data };
    fs.writeFileSync(this.path, JSON.stringify(toWrite, null, 2), 'utf8');
  }

  get() {
    return this.data;
  }

  update(partial) {
    this.data = deepMerge(this.data, partial || {});
    this.save();
    // re-apply env so secrets from K8s still win after UI save of non-secret fields
    this.data = applyEnvOverrides(this.data);
    return this.data;
  }

  validateApiKey(key) {
    if (!key) return false;
    const keys = String(this.data.api_keys || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!keys.length) return true;
    return keys.includes(key);
  }

  getAdminPassword() {
    return this.data.admin_password || 'admin';
  }

  getTempMail() {
    return { ...defaultSettings().temp_mail, ...(this.data.temp_mail || {}) };
  }

  getProxyPool() {
    return { ...defaultSettings().proxy_pool, ...(this.data.proxy_pool || {}) };
  }

  getDefaultMode() {
    // Only logged-in session mode is supported (cookie accounts).
    // Historical aliases: cn | session | login
    return 'session';
  }

  getKeepaliveInterval() {
    const n = Number(this.data.keepalive_interval_seconds || 21600);
    return Math.max(300, n);
  }
}

export const config = new ConfigStore();

export const paths = {
  root: ROOT_DIR,
  data: DATA_DIR,
  sqlite: SQLITE_PATH,
  config: CONFIG_PATH,
  public: path.join(ROOT_DIR, 'public'),
};

export const LONGCAT = {
  base: 'https://longcat.chat',
  overseaV2: 'https://longcat.chat/api/v1/chat-completion-oversea-V2',
  oversea: 'https://longcat.chat/api/v1/chat-completion-oversea',
  cnV2: 'https://longcat.chat/api/v1/chat-completion-V2',
  sessionCreate: 'https://longcat.chat/api/v1/session-create',
  userCurrent: 'https://longcat.chat/api/v1/user-current',
  loginInfo: 'https://longcat.chat/api/v1/login-info',
  appkey: 'fe_com.sankuai.friday.fe.longcat',
};
