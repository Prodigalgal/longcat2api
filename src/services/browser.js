/**
 * Anti-detect browser launcher for Mykeeta registration.
 *
 * Backends (no stock Playwright package):
 *   1. Camoufox (Firefox anti-FP) via camoufox-js  — preferred
 *   2. Patchright Chromium                         — fallback
 *
 * Env:
 *   LONGCAT2API_BROWSER_ENGINE=camoufox|patchright  (default camoufox)
 *   LONGCAT2API_REGISTER_HEADLESS=0                 headed (recommended local)
 *   CAMOUFOX_INSTALL_DIR                            custom Camoufox cache
 */

import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @typedef {'camoufox'|'patchright'} BrowserEngine */

function preferredEngine() {
  const raw = (process.env.LONGCAT2API_BROWSER_ENGINE || process.env.REGISTER_BROWSER || 'camoufox')
    .toLowerCase()
    .trim();
  if (raw === 'patchright' || raw === 'chromium') return 'patchright';
  return 'camoufox';
}

export function isHeaded() {
  return process.env.LONGCAT2API_REGISTER_HEADLESS === '0';
}

export function toBrowserProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    return { server: `${u.protocol}//${u.host}` };
  } catch {
    return { server: proxyUrl };
  }
}

function ensureDirs() {
  const home = process.env.HOME || os.homedir() || process.cwd();
  const candidates = [
    process.env.TMPDIR,
    process.env.TEMP,
    process.env.TMP,
    path.join(home, '.cache'),
    path.join(process.cwd(), 'data', 'browser-artifacts'),
    process.env.CAMOUFOX_INSTALL_DIR,
  ].filter(Boolean);
  for (const d of candidates) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Windows camoufox-js stores under %LOCALAPPDATA%/camoufox by default.
 */
export function resolveCamoufoxInstallDir() {
  if (process.env.CAMOUFOX_INSTALL_DIR) return process.env.CAMOUFOX_INSTALL_DIR;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'camoufox');
  }
  return path.join(os.homedir(), '.cache', 'camoufox');
}

/**
 * Context options shared by both backends.
 * Camoufox already spoofs UA/fingerprint — keep overrides light.
 */
export function defaultContextOptions({ engine } = {}) {
  const base = {
    locale: process.env.LONGCAT2API_LOCALE || 'en-US',
    timezoneId: process.env.LONGCAT2API_TZ || 'Asia/Hong_Kong',
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: true,
    hasTouch: false,
    isMobile: false,
    colorScheme: 'light',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  };
  // Patchright Chromium benefits from an explicit modern UA; Camoufox generates its own.
  if (engine === 'patchright') {
    base.userAgent =
      process.env.LONGCAT2API_UA ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
  return base;
}

async function launchCamoufox({ headless, proxy }) {
  const { Camoufox } = await import('camoufox-js');
  // Camoufox accepts proxy as string or Playwright proxy object
  const proxyOpt = proxy
    ? typeof proxy === 'string'
      ? proxy
      : proxy.server
    : undefined;

  // IMPORTANT: do NOT pass `locale` here.
  // camoufox-js StatisticalLocaleSelector loads territoryInfo.xml asynchronously
  // without await; passing locale races and throws:
  //   Cannot read properties of undefined (reading 'territoryInfo')
  // Locale is applied via browser.newContext({ locale }) instead.
  const browser = await Camoufox({
    headless: !!headless,
    // Slider/captcha code already does human-like moves; avoid double humanize lag
    humanize: false,
    // Proxy fingerprints must agree with their egress location. Camoufox also
    // warns that proxy sessions without geoip are high-risk.
    geoip: proxy ? true : process.env.LONGCAT2API_CAMOUFOX_GEOIP === '1',
    proxy: proxyOpt || undefined,
    os: 'windows',
    window: [1280, 900],
    block_webrtc: true,
    firefox_user_prefs: {
      'security.sandbox.content.level': 0,
      'intl.accept_languages': 'en-US, en',
    },
    env: {
      ...process.env,
      MOZ_DISABLE_CONTENT_SANDBOX: '1',
    },
  });
  return browser;
}

async function launchPatchright({ headless, proxy }) {
  const { chromium } = await import('patchright');
  const browser = await chromium.launch({
    headless: !!headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1280,900',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    proxy: proxy || undefined,
    timeout: Number(process.env.LONGCAT2API_REG_GOTO_MS || 120000),
  });
  return browser;
}

/**
 * Launch browser with Camoufox preferred, Patchright fallback.
 * Returns { browser, engine, close } — always call close() in finally.
 *
 * @param {{ headless?: boolean, proxyUrl?: string|null, preferred?: string }} opts
 */
export async function launchBrowser(opts = {}) {
  ensureDirs();
  const headed = opts.headless === false || isHeaded();
  const headless = !headed;
  const proxy = toBrowserProxy(opts.proxyUrl);
  const preferred = (opts.preferred || preferredEngine()).toLowerCase();

  /** @type {BrowserEngine[]} */
  const order = [];
  if (preferred === 'patchright') {
    order.push('patchright', 'camoufox');
  } else {
    order.push('camoufox', 'patchright');
  }

  const errors = [];
  for (const engine of order) {
    try {
      let browser;
      if (engine === 'camoufox') {
        browser = await launchCamoufox({ headless, proxy });
      } else {
        browser = await launchPatchright({ headless, proxy });
      }
      console.log(
        `[browser] launched engine=${engine} headless=${headless} proxy=${proxy?.server || 'direct'}`
      );
      return {
        browser,
        engine,
        headless,
        async close() {
          try {
            await browser?.close();
          } catch {
            /* ignore */
          }
        },
      };
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(`${engine}: ${msg}`);
      console.warn(`[browser] ${engine} launch failed: ${msg}`);
    }
  }

  throw new Error(
    `No browser backend available (${errors.join(' | ')}). ` +
      `Install: npx camoufox-js fetch  &&  npx patchright install chromium`
  );
}

/**
 * Probe which backends are available (for /health).
 */
export async function browserStatus() {
  const installDir = resolveCamoufoxInstallDir();
  const status = {
    preferred: preferredEngine(),
    headless: !isHeaded(),
    camoufox: {
      available: false,
      detail: '',
      install_dir: installDir,
      install_exists: existsSync(installDir),
      exe_exists: existsSync(path.join(installDir, 'camoufox', 'Cache', 'camoufox.exe'))
        || existsSync(path.join(installDir, 'camoufox.exe')),
    },
    patchright: { available: false, detail: '' },
  };
  try {
    await import('camoufox-js');
    status.camoufox.available = true;
    status.camoufox.detail = status.camoufox.exe_exists
      ? 'package + binary ok'
      : 'package ok (run: npx camoufox-js fetch)';
  } catch (e) {
    status.camoufox.detail = e.message;
  }
  try {
    await import('patchright');
    status.patchright.available = true;
    status.patchright.detail = 'package ok (npx patchright install chromium)';
  } catch (e) {
    status.patchright.detail = e.message;
  }
  return status;
}

// ─── legacy helpers (kept for scripts still importing them) ───────────

/** @deprecated use launchBrowser */
export async function loadChromium() {
  const { chromium } = await import('patchright');
  return { chromium, engine: 'patchright' };
}

/** @deprecated use launchBrowser */
export function launchOptions({ headless, proxy } = {}) {
  const headed = headless === false || isHeaded();
  return {
    headless: !headed,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1280,900',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    proxy: proxy || undefined,
    timeout: Number(process.env.LONGCAT2API_REG_GOTO_MS || 120000),
  };
}
