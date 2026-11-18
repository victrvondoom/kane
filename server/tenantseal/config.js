// TenantSeal configuration. Strictly validated before any browser run.
// Credentials are never stored here: a persona names an environment variable (passwordEnv) and the value is read
// at run time and passed to Kane only through the variables mechanism.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_RELATIVE = path.join('.tenantseal', 'config.json');

export class TenantConfigError extends Error {
  constructor(message) { super(message); this.name = 'TenantConfigError'; }
}

const DEFAULTS = {
  policy: { denialStatuses: [401, 403, 404], permittedPaths: [] },
  limits: { timeoutSeconds: 180, maxRuns: 40, retries: 1 },
  records: { bodyField: 'body' },
  securityPaths: ['**/*auth*', '**/*policy*', '**/*permission*', '**/*access*', '**/*route*', '**/*api*', '**/*tenant*', '**/*owner*', '**/*middleware*', 'server/**', 'demo/tenant-boundary/app.js'],
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, where, { max = 500 } = {}) => {
  if (v === undefined || v === null || v === '') throw new TenantConfigError(`${where} is required`);
  if (typeof v !== 'string' || v.length > max) throw new TenantConfigError(`${where} must be a string of at most ${max} characters`);
  return v;
};

/** Validate and normalise a configuration object. Throws TenantConfigError with the exact field to fix. */
export function validateConfig(raw) {
  if (!isObj(raw)) throw new TenantConfigError('configuration must be a JSON object');
  if (raw.version !== 1) throw new TenantConfigError('"version" must be 1');

  if (!isObj(raw.target)) throw new TenantConfigError('"target" is required');
  let target;
  try { target = new URL(str(raw.target.url, 'target.url')); } catch { throw new TenantConfigError('target.url must be an absolute URL'); }
  if (!/^https?:$/.test(target.protocol)) throw new TenantConfigError('target.url must use http or https');
  const allowedOrigin = raw.target.allowedOrigin ? new URL(raw.target.allowedOrigin).origin : target.origin;
  if (allowedOrigin !== target.origin) throw new TenantConfigError('target.allowedOrigin must equal the origin of target.url');

  if (!isObj(raw.personas)) throw new TenantConfigError('"personas" is required');
  const persona = (name, required) => {
    const p = raw.personas[name];
    if (!p) { if (required) throw new TenantConfigError(`personas.${name} is required`); return { anonymous: true }; }
    if (!isObj(p)) throw new TenantConfigError(`personas.${name} must be an object`);
    if (name === 'anonymous') return { anonymous: true };
    if ('password' in p) throw new TenantConfigError(`personas.${name} must not contain a password; use passwordEnv`);
    const identity = str(p.identity, `personas.${name}.identity`, { max: 64 });
    if (!/^[A-Za-z0-9_-]+$/.test(identity)) throw new TenantConfigError(`personas.${name}.identity may contain only letters, digits, _ and -`);
    const passwordEnv = str(p.passwordEnv, `personas.${name}.passwordEnv`, { max: 100 });
    if (!/^[A-Z_][A-Z0-9_]*$/.test(passwordEnv)) throw new TenantConfigError(`personas.${name}.passwordEnv must be an environment variable name`);
    return { identity, passwordEnv, signedInAssertion: str(p.signedInAssertion || `Signed in as ${identity}`, `personas.${name}.signedInAssertion`, { max: 200 }) };
  };
  const personas = { owner: persona('owner', true), second: persona('second', true), anonymous: persona('anonymous', false) };
  if (personas.owner.identity === personas.second.identity) throw new TenantConfigError('owner and second must be different identities');

  const wf = isObj(raw.workflows) ? raw.workflows : {};
  const workflows = {
    login: str(wf.login || '/login', 'workflows.login', { max: 200 }),
    homePath: str(wf.homePath || '/docs', 'workflows.homePath', { max: 200 }),
    createRecordPath: str(wf.createRecordPath || '/docs/new', 'workflows.createRecordPath', { max: 200 }),
    editPathTemplate: str(wf.editPathTemplate || '/docs/:id/edit', 'workflows.editPathTemplate', { max: 200 }),
    readPathTemplate: str(wf.readPathTemplate || '/docs/:id', 'workflows.readPathTemplate', { max: 200 }),
  };
  if (!workflows.editPathTemplate.includes(':id') || !workflows.readPathTemplate.includes(':id')) throw new TenantConfigError('workflow path templates must contain :id');

  const policy = { ...DEFAULTS.policy, ...(isObj(raw.policy) ? raw.policy : {}) };
  if (!Array.isArray(policy.permittedPaths) || policy.permittedPaths.some((p) => typeof p !== 'string' || !p.startsWith('/'))) throw new TenantConfigError('policy.permittedPaths must be an array of paths starting with /');
  if (!Array.isArray(policy.denialStatuses) || policy.denialStatuses.some((n) => !Number.isInteger(n) || n < 400 || n > 499)) throw new TenantConfigError('policy.denialStatuses must be 4xx integers');

  const limits = { ...DEFAULTS.limits, ...(isObj(raw.limits) ? raw.limits : {}) };
  for (const [k, lo, hi] of [['timeoutSeconds', 30, 900], ['maxRuns', 1, 200], ['retries', 0, 3]]) {
    if (!Number.isInteger(limits[k]) || limits[k] < lo || limits[k] > hi) throw new TenantConfigError(`limits.${k} must be an integer from ${lo} to ${hi}`);
  }

  const manualRoutes = (isObj(raw.discovery) && Array.isArray(raw.discovery.manualRoutes) ? raw.discovery.manualRoutes : []).map((r, i) => {
    if (!isObj(r) || typeof r.template !== 'string' || !r.template.startsWith('/')) throw new TenantConfigError(`discovery.manualRoutes[${i}].template must start with /`);
    return { template: r.template, method: String(r.method || 'GET').toUpperCase(), kind: 'configured' };
  });

  const securityPaths = Array.isArray(raw.securityPaths) ? raw.securityPaths.map((s) => str(s, 'securityPaths[]', { max: 200 })) : DEFAULTS.securityPaths;
  const app = isObj(raw.app) ? raw.app : {};
  return {
    version: 1,
    target: { url: target.href, origin: target.origin },
    personas,
    workflows,
    records: { bodyField: str((isObj(raw.records) && raw.records.bodyField) || DEFAULTS.records.bodyField, 'records.bodyField', { max: 64 }) },
    policy,
    limits,
    discovery: { manualRoutes },
    securityPaths,
    app: { sourceDir: app.sourceDir ? str(app.sourceDir, 'app.sourceDir', { max: 300 }) : '.' },
  };
}

/** Load the configuration of a project. Returns null when absent. */
export function loadTenantConfig(cwd, file = path.join(cwd, CONFIG_RELATIVE)) {
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new TenantConfigError(`${file} is not valid JSON: ${e.message}`); }
  return validateConfig(raw);
}

/** Resolve persona passwords from the environment. Throws naming the missing variable (never its value). */
export function resolveCredentials(config, env = process.env) {
  const out = {};
  for (const name of ['owner', 'second']) {
    const v = env[config.personas[name].passwordEnv];
    if (!v) throw new TenantConfigError(`environment variable ${config.personas[name].passwordEnv} (personas.${name}.passwordEnv) is not set`);
    out[name] = v;
  }
  return out;
}
