import { config } from '../config.js';
import { getProxyUrl, proxyStatus, rotateProxy, startProxy } from './proxyPool.js';

export async function ensureAuthProxy({ onLog } = {}) {
  const log = (message) => {
    console.log(`[MykeetaAuth] ${message}`);
    if (typeof onLog === 'function') onLog(message);
  };
  const proxy = config.getProxyPool();
  if (!proxy.enabled) {
    log('proxy pool disabled; using direct egress');
    return null;
  }
  try {
    if (proxyStatus().status === 'running') await rotateProxy();
    else await startProxy({ pickRandom: true });
    const url = getProxyUrl();
    if (!url) throw new Error('proxy started without local URL');
    log(`proxy ready: ${url}`);
    return url;
  } catch (error) {
    throw new Error(`proxy required but unavailable: ${error.message}`);
  }
}

export function cookiesToLongcatSession(cookies = []) {
  const domains = ['longcat.chat', 'mykeeta.com', 'meituan.com'];
  const values = new Map();
  for (const cookie of cookies) {
    if (domains.some((domain) => String(cookie.domain || '').includes(domain))) {
      values.set(cookie.name, cookie.value);
    }
  }
  return {
    header: [...values.entries()].map(([key, value]) => `${key}=${value}`).join('; '),
    passport_token: values.get('passport_token_key') || '',
    lxsdk_cuid: values.get('_lxsdk_cuid') || '',
    lxsdk_s: values.get('_lxsdk_s') || '',
  };
}

export function isLongcatUrl(value) {
  try {
    const hostname = new URL(String(value)).hostname.toLowerCase();
    return hostname === 'longcat.chat' || hostname.endsWith('.longcat.chat');
  } catch {
    return false;
  }
}
