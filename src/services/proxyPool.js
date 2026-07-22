/**
 * VLESS subscription → local sing-box mixed inbound (HTTP/SOCKS)
 * Registration / optional chat traffic can use getProxyUrl()
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { paths, config } from '../config.js';

const state = {
  settings: null,
  nodes: [],
  proc: null,
  listenPort: 17890,
  selectedTag: '',
  status: 'stopped',
  lastError: '',
  lastFetch: 0,
  binary: '',
};

function dataRoot() {
  const root = paths.data;
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function binDir() {
  const p = path.join(dataRoot(), '.bin');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function configDir() {
  const p = path.join(dataRoot(), '.singbox');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function pidFile() {
  return path.join(configDir(), 'sing-box.pid');
}

function cfgFile() {
  return path.join(configDir(), 'config.json');
}

function loadSettings() {
  state.settings = config.getProxyPool();
  state.listenPort = Number(state.settings.listen_port || 17890);
  return state.settings;
}

export function configureProxyPool(partial) {
  const prev = config.getProxyPool();
  const next = { ...prev, ...partial };
  config.update({ proxy_pool: next });
  loadSettings();
  return state.settings;
}

export function getProxyUrl() {
  loadSettings();
  if (!state.settings?.enabled || state.status !== 'running') return null;
  return `http://127.0.0.1:${state.listenPort}`;
}

export function proxyStatus() {
  loadSettings();
  return {
    enabled: !!state.settings?.enabled,
    status: state.status,
    listen_port: state.listenPort,
    proxy_url: getProxyUrl(),
    pid: state.proc?.pid || null,
    node_count: state.nodes.length,
    selected: state.selectedTag,
    binary: state.binary,
    last_error: state.lastError,
    last_fetch: state.lastFetch,
    sub_configured: !!(state.settings?.sub_url),
    nodes: state.nodes.slice(0, 50).map((n) => ({
      name: n.name,
      server: n.server,
      port: n.port,
      tag: n.tag,
    })),
  };
}

function parseVless(uri) {
  try {
    if (!uri.startsWith('vless://')) return null;
    const u = new URL(uri);
    const uuid = decodeURIComponent(u.username);
    const server = u.hostname;
    const port = Number(u.port || 443);
    const qs = Object.fromEntries(u.searchParams.entries());
    const name = decodeURIComponent(u.hash.replace(/^#/, '') || `${server}:${port}`);
    const tagSafe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'node';
    return {
      name,
      uuid,
      server,
      port,
      security: qs.security || 'tls',
      network: qs.type || qs.network || 'tcp',
      host: qs.host || '',
      path: decodeURIComponent(qs.path || '/'),
      sni: qs.sni || qs.host || '',
      fp: qs.fp || 'chrome',
      flow: qs.flow || '',
      tag: `vless-${tagSafe}-${server.replace(/\./g, '-').slice(0, 20)}-${port}`,
    };
  } catch {
    return null;
  }
}

function decodeSubscription(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text.includes('vless://') && !text.startsWith('dmxlc3M')) {
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  try {
    const pad = '='.repeat((4 - (text.length % 4)) % 4);
    const dec = Buffer.from(text + pad, 'base64').toString('utf8');
    return dec.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
}

export async function fetchNodes(subUrl) {
  const url = subUrl || loadSettings().sub_url;
  if (!url) throw new Error('未配置代理订阅 URL');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'longcat2api-ProxyPool/1.0' },
  });
  if (!res.ok) throw new Error(`拉取订阅失败 HTTP ${res.status}`);
  const lines = decodeSubscription(await res.text());
  const nodes = [];
  for (const ln of lines) {
    if (!ln.startsWith('vless://')) continue;
    const n = parseVless(ln);
    if (n) nodes.push(n);
  }
  if (!nodes.length) throw new Error('订阅中未解析到 VLESS 节点');
  state.nodes = nodes;
  state.lastFetch = Date.now();
  return nodes;
}

function vlessOutbound(node) {
  const ob = {
    type: 'vless',
    tag: node.tag,
    server: node.server,
    server_port: node.port,
    uuid: node.uuid,
    packet_encoding: 'xudp',
  };
  if (node.flow) ob.flow = node.flow;
  if (['tls', 'reality'].includes(String(node.security || '').toLowerCase())) {
    ob.tls = {
      enabled: true,
      server_name: node.sni || node.host || node.server,
      insecure: false,
      utls: node.fp ? { enabled: true, fingerprint: node.fp } : undefined,
    };
  }
  const net = String(node.network || 'tcp').toLowerCase();
  if (net === 'ws') {
    ob.transport = {
      type: 'ws',
      path: node.path || '/',
      headers: node.host ? { Host: node.host } : undefined,
    };
  } else if (net === 'grpc') {
    ob.transport = { type: 'grpc', service_name: node.path || '' };
  }
  return ob;
}

function buildSingboxConfig(nodes, listenPort, selectedTag) {
  const outbounds = nodes.map(vlessOutbound);
  const tags = outbounds.map((o) => o.tag);
  const def = tags.includes(selectedTag) ? selectedTag : tags[0];
  outbounds.push({ type: 'selector', tag: 'select', outbounds: tags, default: def });
  outbounds.push({ type: 'direct', tag: 'direct' });
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: listenPort,
      },
    ],
    outbounds,
    route: { final: 'select' },
  };
}

function findSingbox(explicit = '') {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.SING_BOX_PATH && fs.existsSync(process.env.SING_BOX_PATH)) {
    return process.env.SING_BOX_PATH;
  }
  const local = path.join(binDir(), process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
  if (fs.existsSync(local)) return local;
  try {
    const which = process.platform === 'win32' ? 'where sing-box' : 'which sing-box';
    const out = execSync(which, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch {
    /* not found */
  }
  return '';
}

function killPid(pid, force = false) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill ${force ? '/F ' : ''}/T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    /* ignore */
  }
}

export function reclaimProxy() {
  const killed = [];
  if (state.proc?.pid) {
    killPid(state.proc.pid, true);
    killed.push(state.proc.pid);
    state.proc = null;
  }
  try {
    if (fs.existsSync(pidFile())) {
      const pid = Number(fs.readFileSync(pidFile(), 'utf8').trim());
      if (pid) {
        killPid(pid, true);
        killed.push(pid);
      }
      fs.unlinkSync(pidFile());
    }
  } catch {
    /* ignore */
  }
  state.status = 'stopped';
  return { killed };
}

export async function startProxy({ pickRandom = true } = {}) {
  loadSettings();
  if (!state.settings.enabled) throw new Error('代理池未启用');
  if (!state.settings.sub_url) throw new Error('未配置订阅 URL');

  reclaimProxy();
  const nodes = await fetchNodes();
  let selected = state.selectedTag;
  if (pickRandom || !selected) {
    selected = nodes[Math.floor(Math.random() * nodes.length)].tag;
  }
  state.selectedTag = selected;

  const cfg = buildSingboxConfig(nodes, state.listenPort, selected);
  fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2), 'utf8');

  let binary = findSingbox(state.settings.singbox_path || '');
  if (!binary) {
    throw new Error(
      '未找到 sing-box。请安装 sing-box 并配置 proxy_pool.singbox_path，或放入 data/.bin/'
    );
  }
  state.binary = binary;

  const child = spawn(binary, ['run', '-c', cfgFile()], {
    cwd: configDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  state.proc = child;
  fs.writeFileSync(pidFile(), String(child.pid), 'utf8');

  child.stderr?.on('data', (d) => {
    const s = d.toString();
    if (/error|failed/i.test(s)) state.lastError = s.slice(0, 300);
  });
  child.on('exit', (code) => {
    if (state.proc?.pid === child.pid) {
      state.proc = null;
      state.status = 'stopped';
      state.lastError = `sing-box exited code=${code}`;
    }
  });

  // wait port
  await sleep(800);
  state.status = 'running';
  state.lastError = '';
  return proxyStatus();
}

export async function stopProxy() {
  reclaimProxy();
  return proxyStatus();
}

export async function rotateProxy() {
  loadSettings();
  if (!state.nodes.length) await fetchNodes();
  if (!state.nodes.length) throw new Error('无节点');
  const others = state.nodes.filter((n) => n.tag !== state.selectedTag);
  const pick = (others.length ? others : state.nodes)[
    Math.floor(Math.random() * (others.length || state.nodes.length))
  ];
  state.selectedTag = pick.tag;
  return startProxy({ pickRandom: false });
}

export async function testProxyConnectivity() {
  const url = getProxyUrl();
  if (!url) return { ok: false, error: '代理未运行' };
  try {
    const { ProxyAgent, fetch: ufetch } = await import('undici');
    const agent = new ProxyAgent(url);
    const res = await ufetch('https://www.cloudflare.com/cdn-cgi/trace', {
      dispatcher: agent,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// load on import
loadSettings();
