// On-call agent configuration. Everything is read from the environment on the server; nothing here reaches the browser.
import path from 'node:path';

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const int = (v, d, min = 0) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d; };
/** Split a command line into argv without a shell (quotes supported). Commands are never passed to `sh -c`. */
export function argv(line) {
  const out = []; let m; const rx = /"([^"]*)"|'([^']*)'|(\S+)/g;
  while ((m = rx.exec(String(line || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function oncallConfig(env = process.env, { workspaceDir = process.cwd() } = {}) {
  return {
    enabled: env.ONCALL_ENABLED !== '0',
    // Roles. A signed-up account alone grants nothing: each tier names the accounts that hold it. '*' = every signed-in user.
    readers: list(env.ONCALL_READERS), engineers: list(env.ONCALL_ENGINEERS), approvers: list(env.ONCALL_APPROVERS),
    repoDir: path.resolve(env.ONCALL_REPO_DIR || workspaceDir),
    baseBranch: env.ONCALL_BASE_BRANCH || '',
    branchPrefix: 'oncall/',
    testCommand: argv(env.ONCALL_TEST_COMMAND || 'npm test'),
    buildCommand: argv(env.ONCALL_BUILD_COMMAND || ''),
    lintCommand: argv(env.ONCALL_LINT_COMMAND || ''),
    checkTimeoutMs: int(env.ONCALL_CHECK_TIMEOUT_SECONDS, 900, 5) * 1000,
    github: { token: env.ONCALL_GITHUB_TOKEN || '', api: (env.ONCALL_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''), repo: env.ONCALL_GITHUB_REPO || '' },
    voice: { provider: env.ONCALL_VOICE_PROVIDER || 'openai-live', apiKey: env.OPENAI_API_KEY || '', model: env.ONCALL_VOICE_MODEL || 'gpt-live-1', voice: env.ONCALL_VOICE || 'meridian',
      baseUrl: (env.ONCALL_VOICE_BASE_URL || 'https://api.openai.com').replace(/\/$/, ''), allowProviderStore: env.ONCALL_PROVIDER_STORE === '1' },
    reasoning: { provider: env.ONCALL_REASONING_PROVIDER || 'anthropic', model: env.ONCALL_REASONING_MODEL || 'claude-opus-5-5', effort: env.ONCALL_REASONING_EFFORT || 'high',
      configured: !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN), fallbacks: env.ONCALL_REASONING_FALLBACKS !== '0' },
    telephony: { provider: env.ONCALL_TELEPHONY_PROVIDER || '' },
    maxSessionMs: int(env.ONCALL_MAX_SESSION_MINUTES, 60, 1) * 60000,
    idleMs: int(env.ONCALL_IDLE_SECONDS, 120, 10) * 1000,
    maxToolCallsPerTurn: int(env.ONCALL_MAX_TOOL_CALLS_PER_TURN, 80, 1),
    toolRate: { max: int(env.ONCALL_TOOL_RATE_MAX, 240, 1), windowMs: 10 * 60000 },
    transcriptRetentionDays: int(env.ONCALL_TRANSCRIPT_RETENTION_DAYS, 30, 0), // 0 = transcripts are never written to disk
    authorizationTtlMs: int(env.ONCALL_AUTHORIZATION_TTL_MINUTES, 10, 1) * 60000,
  };
}

export const TIERS = ['read_only', 'engineering', 'production'];
/** Highest tier this account holds, or null when the feature is not granted to it at all. */
export function roleOf(cfg, user) {
  const email = String(user?.email || '').toLowerCase();
  const has = (l) => l.includes('*') || l.includes(email);
  if (!email) return null;
  if (has(cfg.approvers)) return 'production';
  if (has(cfg.engineers)) return 'engineering';
  if (has(cfg.readers)) return 'read_only';
  return null;
}
export const tierAllows = (held, needed) => TIERS.indexOf(held) >= TIERS.indexOf(needed) && TIERS.indexOf(held) >= 0;
