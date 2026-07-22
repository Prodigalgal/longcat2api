import { config } from '../config.js';

export function extractBearer(req) {
  const h = req.headers.authorization || req.headers['x-api-key'] || '';
  if (typeof h !== 'string') return '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return h.trim();
}

export function requireApiKey(req, res, next) {
  const key = extractBearer(req);
  if (!config.validateApiKey(key)) {
    return res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
  }
  next();
}

function adminUnauthorized(req, res) {
  // Single browser Basic challenge — no separate SPA login form.
  res.set('WWW-Authenticate', 'Basic realm="longcat2api", charset="UTF-8"');
  const wantsHtml =
    req.method === 'GET' &&
    (req.accepts(['html', 'json']) === 'html' ||
      String(req.headers.accept || '').includes('text/html'));
  if (wantsHtml) {
    return res.status(401).type('text/plain').send('Unauthorized');
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

/** HTTP Basic only (user fixed: admin). Used for admin UI + /api/* management. */
export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    return adminUnauthorized(req, res);
  }
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : decoded;
    const pass = i >= 0 ? decoded.slice(i + 1) : '';
    if (user !== 'admin' || pass !== config.getAdminPassword()) {
      return adminUnauthorized(req, res);
    }
    next();
  } catch {
    return adminUnauthorized(req, res);
  }
}
