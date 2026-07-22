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

export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="longcat2api"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : decoded;
    const pass = i >= 0 ? decoded.slice(i + 1) : '';
    if (user !== 'admin' || pass !== config.getAdminPassword()) {
      res.set('WWW-Authenticate', 'Basic realm="longcat2api"');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  } catch {
    res.set('WWW-Authenticate', 'Basic realm="longcat2api"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
}
