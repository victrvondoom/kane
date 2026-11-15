// Secret redaction applied to everything that leaves the tool layer: tool output, transcripts, events, reports, logs.
const PATTERNS = [
  [/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, '«redacted:api-key»'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '«redacted:github-token»'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '«redacted:aws-key»'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '«redacted:slack-token»'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '«redacted:jwt»'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '«redacted:private-key»'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 «redacted»'],
  [/(:\/\/[^\s:/@]+):[^\s:/@]+@/g, '$1:«redacted»@'],
  // key = value / "key": "value" for names that look like credentials
  [/((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi, '$1«redacted»'],
];

export function createRedactor(secrets = []) {
  const known = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 6))].sort((a, b) => b.length - a.length);
  const text = (input) => {
    let out = String(input ?? '');
    for (const s of known) if (out.includes(s)) out = out.split(s).join('«redacted»');
    for (const [rx, to] of PATTERNS) out = out.replace(rx, to);
    return out;
  };
  const deep = (v) => typeof v === 'string' ? text(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
  return { text, deep, add: (s) => { if (typeof s === 'string' && s.length >= 6 && !known.includes(s)) { known.push(s); known.sort((a, b) => b.length - a.length); } } };
}
/** Values of environment variables whose names look like credentials. */
export const envSecrets = (env = process.env) => Object.entries(env).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(k) && v && v.length >= 6).map(([, v]) => v);
/** Environment for child processes the agent starts: credentials are removed, toolchain variables stay. */
export function scrubbedEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|^LT_|COOKIE|^GIT_CONFIG_|^NODE_TEST_CONTEXT$/i.test(k)) out[k] = v;
  return { ...out, ...extra };
}
