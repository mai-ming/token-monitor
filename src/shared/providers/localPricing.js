'use strict';

// Local pricing resolution for the clients this build parses itself.
//
// Upstream used to carry this in collector.js and removed it when Proma and
// Qoder CN moved into the tokscale fork. LiveAgent and Pi Desktop are parsed
// in-process (see providers/liveagent, providers/pi/desktopUsage), so they
// still need a way to price the rows they read: the `tokscale pricing` command
// for a live lookup, with tokscale's own on-disk catalog as the offline
// fallback — the command's own fallback costs 20-30s of network timeouts, far
// past the lookup budget this module enforces.
//
// Lives here rather than in collector.js so an upstream sync does not have to
// re-resolve ~300 lines upstream deliberately deleted.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { customPricingPath, tokscaleConfigDir, tokscaleHomeDir } = require('../tokscaleConfig');

// Upstream removed tokscaleCacheDirs from tokscaleConfig along with this pricing
// layer, so it lives here now. Kept byte-for-byte in behaviour: it mirrors
// tokscale-core's canonical cache root plus its two pre-#470 legacy fallbacks.
function profileHomeDir(homeDir) {
  return typeof homeDir === 'string' && homeDir.length > 0 ? homeDir : os.homedir();
}

function tokscaleCacheDirs(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const profileHome = profileHomeDir(options.homeDir);
  const tokscaleHome = tokscaleHomeDir({ env, platform, homeDir: profileHome });
  const canonical = path.join(tokscaleConfigDir({ env, platform, homeDir: profileHome }), 'cache');
  const override = env.TOKSCALE_CONFIG_DIR;
  if (typeof override === 'string' && override.length > 0) return [canonical];

  let platformCache;
  if (platform === 'darwin') {
    platformCache = path.join(profileHome, 'Library', 'Caches', 'tokscale');
  } else if (platform === 'win32') {
    const localAppData = (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0)
      ? env.LOCALAPPDATA
      : path.join(profileHome, 'AppData', 'Local');
    platformCache = path.join(localAppData, 'tokscale');
  } else {
    const xdg = env.XDG_CACHE_HOME;
    const cacheHome = (typeof xdg === 'string' && path.isAbsolute(xdg)) ? xdg : path.join(profileHome, '.cache');
    platformCache = path.join(cacheHome, 'tokscale');
  }

  return [...new Set([
    canonical,
    platformCache,
    path.join(tokscaleHome, '.cache', 'tokscale')
  ])];
}

const LOCAL_PRICING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LOCAL_PRICING_LOOKUP_TIMEOUT_MS = 3000;
const localPricingCache = new Map();

// tokscale maintains its own pricing catalog cache under its config dir
// (cache/pricing-{litellm,openrouter,models-dev}.json): the `tokscale pricing`
// command refreshes these over the network and falls back to them when offline
// — but that fallback costs 20-30s of network timeouts, far past the 3s lookup
// budget (LOCAL_PRICING_LOOKUP_TIMEOUT_MS), which is why local clients' costs
// show zero on machines without catalog access. Read the same local files
// directly (zero network) as the offline fallback: when the command fails, the
// catalog it would have fallen back to is already on disk.
const TOKSCALE_PRICING_CATALOG_FILES = ['pricing-litellm.json', 'pricing-openrouter.json', 'pricing-models-dev.json'];
const TOKSCALE_MODEL_PRICING_RATE_FIELDS = [
  'input_cost_per_token',
  'input_cost_per_token_above_128k_tokens',
  'input_cost_per_token_above_200k_tokens',
  'input_cost_per_token_above_256k_tokens',
  'input_cost_per_token_above_272k_tokens',
  'output_cost_per_token',
  'output_cost_per_token_above_128k_tokens',
  'output_cost_per_token_above_200k_tokens',
  'output_cost_per_token_above_256k_tokens',
  'output_cost_per_token_above_272k_tokens',
  'cache_creation_input_token_cost',
  'cache_creation_input_token_cost_above_200k_tokens',
  'cache_read_input_token_cost',
  'cache_read_input_token_cost_above_200k_tokens',
  'cache_read_input_token_cost_above_272k_tokens'
];
const TOKSCALE_ROUTING_LABELS = new Set(['auto', 'agent_review']);
const TOKSCALE_TERMINAL_FALLBACK_BLOCKLIST = new Set([
  'auto', 'mini', 'chat', 'base', 'claude', 'anthropic', 'gemini', 'model', 'router', 'default'
]);
const CATALOG_PRICING_FIELDS = [
  'inputCostPerToken',
  'outputCostPerToken',
  'cacheReadInputTokenCost',
  'cacheCreationInputTokenCost'
];

// Parsed catalog, invalidated by every selected candidate's file metadata.
let tokscaleCatalogCache = { revision: '', catalog: null, recheckAtMs: 0 };

function normalizeCatalogModelKey(key) {
  return String(key || '').trim().toLowerCase();
}

function terminalCatalogModelKey(key) {
  const parts = String(key || '').split('/');
  return parts[parts.length - 1] || '';
}

function normalizePricingRate(value, key) {
  const raw = value?.[key];
  if (raw === null || raw === undefined) return undefined;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function normalizeCatalogPricing(value) {
  const pricing = {
    inputCostPerToken: normalizePricingRate(value, 'input_cost_per_token'),
    outputCostPerToken: normalizePricingRate(value, 'output_cost_per_token'),
    cacheReadInputTokenCost: normalizePricingRate(value, 'cache_read_input_token_cost'),
    cacheCreationInputTokenCost: normalizePricingRate(value, 'cache_creation_input_token_cost')
  };
  return pricing.inputCostPerToken !== undefined || pricing.outputCostPerToken !== undefined ? pricing : null;
}

function catalogPricingFingerprint(pricing) {
  return JSON.stringify(CATALOG_PRICING_FIELDS.map((field) => (
    pricing[field] === undefined ? 'missing' : pricing[field]
  )));
}

function pricingCatalogDirs(options = {}) {
  if (Array.isArray(options.catalogDirs)) return options.catalogDirs.map(String).filter(Boolean);
  if (options.configDir) return [options.configDir];
  return tokscaleCacheDirs(options);
}

function inspectPricingCatalogFile(file) {
  try {
    const stat = fs.statSync(file);
    return {
      file,
      state: 'present',
      revision: `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`
    };
  } catch (error) {
    const code = error?.code || 'unknown';
    return { file, state: code === 'ENOENT' ? 'missing' : 'error', revision: `${file}:${code}` };
  }
}

function pricingCatalogSource(name, dirs) {
  if (dirs.length === 0) return { candidates: [], revision: `${name}:missing` };
  const canonical = inspectPricingCatalogFile(path.join(dirs[0] || '', name));
  // Canonical is authoritative whenever it exists or cannot be inspected.
  // Only ENOENT activates upstream's ordered legacy find_map fallback.
  const probes = canonical.state === 'missing'
    ? [canonical, ...dirs.slice(1).map((dir) => inspectPricingCatalogFile(path.join(dir, name)))]
    : [canonical];
  return {
    candidates: probes.filter((entry) => entry.state !== 'missing'),
    revision: probes.map((entry) => entry.revision).join('|')
  };
}

function tokscalePricingCatalogSnapshot(options = {}) {
  const dirs = pricingCatalogDirs(options);
  const files = TOKSCALE_PRICING_CATALOG_FILES.map((name) => pricingCatalogSource(name, dirs));
  return {
    files,
    revision: `${dirs.join('|')}::${files.map((entry) => entry.revision).join('|')}`
  };
}

function parseTokscalePricingCatalogFile(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (!Number.isSafeInteger(doc.timestamp) || doc.timestamp < 0) return null;
  if (!doc.data || typeof doc.data !== 'object' || Array.isArray(doc.data)) return null;
  // Tokscale deserializes the whole HashMap<String, ModelPricing> before using
  // it. A wrong type in any known Option<f64> field makes that source invalid;
  // do not salvage rows from a cache Tokscale itself would reject.
  for (const value of Object.values(doc.data)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    for (const field of TOKSCALE_MODEL_PRICING_RATE_FIELDS) {
      const raw = value[field];
      if (raw !== null && raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw))) {
        return null;
      }
    }
  }
  return doc;
}

// Preserve complete catalog keys. A bare model id may use a terminal-key
// fallback only when every matching entry publishes exactly the same rates;
// otherwise guessing a provider would turn "cost unavailable" into a wrong
// cost. Full exact keys and bare exact keys always win before that fallback.
function tokscalePricingCatalog(options = {}) {
  const snapshot = tokscalePricingCatalogSnapshot(options);
  const nowMs = options.nowMs ?? Date.now();
  if (
    tokscaleCatalogCache.revision === snapshot.revision
    && tokscaleCatalogCache.catalog
    && (!tokscaleCatalogCache.recheckAtMs || nowMs < tokscaleCatalogCache.recheckAtMs)
  ) {
    return tokscaleCatalogCache.catalog;
  }
  const exact = new Map();
  const byTerminal = new Map();
  const nowSeconds = Math.floor(nowMs / 1000);
  let recheckAtMs = 0;
  for (const source of snapshot.files) {
    let doc = null;
    for (const candidate of source.candidates) {
      doc = parseTokscalePricingCatalogFile(candidate.file);
      if (doc) break;
    }
    if (!doc) continue;
    const timestamp = doc?.timestamp;
    if (timestamp > nowSeconds) {
      const eligibleAtMs = timestamp * 1000;
      recheckAtMs = recheckAtMs ? Math.min(recheckAtMs, eligibleAtMs) : eligibleAtMs;
      continue;
    }
    for (const [key, value] of Object.entries(doc.data)) {
      const modelId = normalizeCatalogModelKey(key);
      if (!modelId) continue;
      const pricing = normalizeCatalogPricing(value);
      if (!pricing) continue;
      if (!exact.has(modelId)) exact.set(modelId, pricing);
      const terminal = terminalCatalogModelKey(modelId);
      if (!terminal) continue;
      if (!byTerminal.has(terminal)) byTerminal.set(terminal, []);
      byTerminal.get(terminal).push({ modelId, pricing });
    }
  }
  const catalogRevision = recheckAtMs ? `${snapshot.revision}:before:${recheckAtMs}` : snapshot.revision;
  const catalog = { revision: catalogRevision, exact, byTerminal };
  tokscaleCatalogCache = { revision: snapshot.revision, catalog, recheckAtMs };
  return catalog;
}

function readTokscalePricingCatalog(modelId, options = {}) {
  const key = String(modelId || '').trim().toLowerCase();
  if (!key) return null;
  // Bare router labels never identify the model that actually served usage.
  // A qualified key such as morph/auto remains eligible for exact lookup.
  if (TOKSCALE_ROUTING_LABELS.has(key)) return null;
  const catalog = tokscalePricingCatalog(options);
  const exact = catalog.exact.get(key);
  if (exact) return exact;
  // A provider-scoped id that does not exist exactly must not borrow another
  // provider's terminal match.
  if (key.includes('/')) return null;
  if (TOKSCALE_TERMINAL_FALLBACK_BLOCKLIST.has(key)) return null;
  const candidates = catalog.byTerminal.get(key) || [];
  if (candidates.length === 0) return null;
  const fingerprints = new Set(candidates.map(({ pricing }) => catalogPricingFingerprint(pricing)));
  return fingerprints.size === 1 ? candidates[0].pricing : null;
}

function resetTokscaleCatalogCache() {
  tokscaleCatalogCache = { revision: '', catalog: null, recheckAtMs: 0 };
}

function tokscalePricingCatalogRevision(options = {}) {
  const snapshot = tokscalePricingCatalogSnapshot(options);
  const nowMs = options.nowMs ?? Date.now();
  if (tokscaleCatalogCache.revision !== snapshot.revision || !tokscaleCatalogCache.catalog) {
    return snapshot.revision;
  }
  if (tokscaleCatalogCache.recheckAtMs && nowMs >= tokscaleCatalogCache.recheckAtMs) {
    return `${snapshot.revision}:recheck:${tokscaleCatalogCache.recheckAtMs}`;
  }
  return tokscaleCatalogCache.catalog.revision;
}

function localPricingRevision() {
  try { return fs.statSync(customPricingPath()).mtimeMs; } catch (_) { return 0; }
}

function normalizeLocalPricing(result) {
  const source = result?.pricing;
  if (!source || typeof source !== 'object') return null;
  const pricing = {
    inputCostPerToken: normalizePricingRate(source, 'inputCostPerToken'),
    outputCostPerToken: normalizePricingRate(source, 'outputCostPerToken'),
    cacheReadInputTokenCost: normalizePricingRate(source, 'cacheReadInputTokenCost'),
    cacheCreationInputTokenCost: normalizePricingRate(source, 'cacheCreationInputTokenCost')
  };
  return pricing.inputCostPerToken !== undefined || pricing.outputCostPerToken !== undefined ? pricing : null;
}

async function resolveLocalModelPricing(rows, options = {}) {
  const lookup = options.lookupModelPricing;
  if (typeof lookup !== 'function') {
    throw new Error('resolveLocalModelPricing requires a lookupModelPricing function');
  }
  const customRevision = options.pricingRevision ?? localPricingRevision();
  const nowMs = options.nowMs ?? Date.now();
  const currentRevision = () => `${customRevision}|${tokscalePricingCatalogRevision({ ...options, nowMs })}`;
  let revision = currentRevision();
  // Pricing is supplementary: never let a missing catalog entry hold up the
  // live usage refresh for the normal tokscale command timeout.
  const commandTimeoutMs = options.commandTimeoutMs || LOCAL_PRICING_LOOKUP_TIMEOUT_MS;
  const pricingByModel = {};
  const normalizeId = options.normalizeModelId || ((value) => String(value || '').trim().toLowerCase());
  const modelIds = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const rawModelId = String(row?.model || '').trim();
    const modelId = normalizeId(rawModelId);
    if (modelId) modelIds.set(modelId, true);
  }
  for (const [modelId] of modelIds) {
    const cached = localPricingCache.get(modelId);
    if (cached && cached.revision === revision && nowMs - cached.at < LOCAL_PRICING_CACHE_TTL_MS) {
      if (cached.pricing) pricingByModel[modelId] = cached.pricing;
      continue;
    }
    let pricing;
    try {
      pricing = normalizeLocalPricing(await lookup(modelId, commandTimeoutMs));
    } catch (_) {
      // An unknown model, offline lookup, or custom channel must remain
      // cost-unavailable instead of inheriting an unrelated catalog price —
      // but when the lookup itself failed (timeout/offline), the price the
      // command would have fallen back to is tokscale's local catalog cache,
      // which is on disk without any network round trip.
      pricing = readTokscalePricingCatalog(modelId, options);
      // Parsing a future-dated source adds its time boundary to the catalog
      // revision, so an unavailable result expires when that source becomes
      // eligible even if the file itself does not change.
      revision = currentRevision();
    }
    localPricingCache.set(modelId, { at: nowMs, revision, pricing });
    if (pricing) pricingByModel[modelId] = pricing;
  }
  return pricingByModel;
}

function resetLocalPricingCache() {
  localPricingCache.clear();
}


module.exports = {
  LOCAL_PRICING_LOOKUP_TIMEOUT_MS,
  normalizeLocalPricing,
  resetLocalPricingCache,
  // Kept exported for parity with the pricing cache's own reset: the tokscale
  // catalog snapshot is cached too, and a caller that clears one wants both.
  resetTokscaleCatalogCache,
  resolveLocalModelPricing
};
