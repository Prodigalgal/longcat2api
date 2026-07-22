/**
 * Model aliases → { agentId, reason, search, mode? }
 * mode optional override: oversea | cn
 */
export const MODEL_ALIASES = {
  'longcat-default': { agentId: '1', reason: false, search: false },
  longcat: { agentId: '1', reason: false, search: false },
  'longcat-flash': { agentId: '1', reason: false, search: false },
  'longcat-reason': { agentId: '1', reason: true, search: false },
  'longcat-thinking': { agentId: '1', reason: true, search: false },
  'longcat-r1': { agentId: '1', reason: true, search: false },
  'longcat-search': { agentId: '1', reason: false, search: true },
  'longcat-reason-search': { agentId: '1', reason: true, search: true },
  'longcat-pro': { agentId: '2', reason: true, search: true },
  'LongCat-Flash': { agentId: '1', reason: false, search: false },
  'LongCat-2.0': { agentId: '1', reason: false, search: false },
  'LongCat-2.0-Preview': { agentId: '1', reason: false, search: false },
};

export function resolveModel(model) {
  const key = String(model || 'longcat-flash');
  if (MODEL_ALIASES[key]) return { ...MODEL_ALIASES[key], id: key };

  const lower = key.toLowerCase();
  // fuzzy
  const reason = /think|reason|r1/.test(lower);
  const search = /search|online/.test(lower);
  const pro = /pro/.test(lower);
  return {
    id: key,
    agentId: pro ? '2' : '1',
    reason,
    search,
  };
}

export function listModels() {
  const seen = new Set();
  const data = [];
  for (const [id, meta] of Object.entries(MODEL_ALIASES)) {
    if (seen.has(id)) continue;
    seen.add(id);
    data.push({
      id,
      object: 'model',
      created: 0,
      owned_by: 'longcat',
      thinking: meta.reason,
      search: meta.search,
    });
  }
  return { object: 'list', data };
}
