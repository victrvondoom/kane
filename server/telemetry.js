// Telemetry from Kane CLI evidence: network traffic (HAR) and console output, read from the files Kane wrote for one
// execution. DIAGNOSTIC ONLY. Nothing here changes a result's status, the evidence freshness or the release gate:
// a criterion that Kane passed but whose page logged errors is reported as "passed with diagnostics", so a reviewer
// sees the problem; SHIPPROOF never rewrites the verdict.
//
// Privacy: URLs are reduced to origin + path (query strings and fragments often carry tokens), and console text is
// redacted for common secret keys. Files are read only from inside the evidence root, and only up to a size limit.
import fs from 'node:fs';
import path from 'node:path';

export const SLOW_MS = 2000;
const MAX_READ = 10 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const SECRET = /((?:token|password|passwd|secret|authorization|cookie|api[_-]?key)\s*[=:]\s*)[^\s,;"']+/gi;

export function redactUrl(raw) {
  try { const u = new URL(String(raw)); return `${u.origin}${u.pathname}`; } catch { return '(unparseable url)'; }
}
export function redactText(s, max = 300) {
  return String(s ?? '').replace(SECRET, '$1[redacted]').replace(/\s+/g, ' ').slice(0, max);
}

/** HAR 1.2: log.entries[]. Failed = status 0 (network failure) or >= 400. */
export function parseHar(text) {
  let har;
  try { har = JSON.parse(text); } catch { return { format: 'invalid', error: 'not valid JSON' }; }
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) return { format: 'invalid', error: 'no log.entries' };
  const reqs = entries.slice(0, MAX_ENTRIES).map((e, index) => ({
    index, startedAt: typeof e.startedDateTime === 'string' ? e.startedDateTime.slice(0, 40) : null,
    mime: typeof e.response?.content?.mimeType === 'string' ? e.response.content.mimeType.slice(0, 80) : null,
    method: String(e.request?.method || 'GET').slice(0, 10),
    url: redactUrl(e.request?.url),
    status: Number.isFinite(e.response?.status) ? e.response.status : 0,
    ms: Math.max(0, Math.round(Number(e.time) || 0)),
    error: e._error ? redactText(e._error, 120) : null,
  }));
  const byStatus = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, failed: 0 };
  for (const r of reqs) {
    if (r.status === 0) byStatus.failed++;
    else if (r.status >= 500) byStatus['5xx']++;
    else if (r.status >= 400) byStatus['4xx']++;
    else if (r.status >= 300) byStatus['3xx']++;
    else byStatus['2xx']++;
  }
  const failures = reqs.filter((r) => r.status === 0 || r.status >= 400);
  const slowest = [...reqs].sort((a, b) => b.ms - a.ms).slice(0, 5).filter((r) => r.ms > 0);
  return { format: 'har', total: entries.length, analysed: reqs.length, byStatus, failed: failures.length,
    slow: reqs.filter((r) => r.ms >= SLOW_MS).length, failures: failures.slice(0, 20), slowest, truncated: entries.length > MAX_ENTRIES };
}

const LEVEL = { error: 'error', warning: 'warning', warn: 'warning' };
/** Console output as NDJSON ({level|type, text|message}) or plain text lines. */
export function parseConsole(text) {
  const samples = [];
  let errors = 0, warnings = 0, format = 'none', lines = 0;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    lines++;
    let level = null, msg = line;
    if (line.startsWith('{')) {
      try { const o = JSON.parse(line); format = format === 'text' ? 'mixed' : 'ndjson';
        const lv = String(o.level || o.type || '').toLowerCase(); msg = String(o.text || o.message || o.msg || '');
        if (LEVEL[lv]) level = LEVEL[lv];
        else if (o.uncaught || /uncaught|unhandled/i.test(msg)) level = 'error'; }
      catch { /* plain text that starts with a brace */ }
    }
    if (!level && format !== 'ndjson') {
      if (/\b(uncaught|unhandled|exception|error)\b/i.test(msg)) level = 'error';
      else if (/\bwarn(ing)?\b/i.test(msg)) level = 'warning';
      if (format === 'none') format = 'text';
    }
    if (level === 'error') errors++; else if (level === 'warning') warnings++;
    if (level && samples.length < 25) samples.push({ level, text: redactText(msg) });
  }
  return { format, lines, errors, warnings, samples };
}

/** Summarise the telemetry files of one result. Reads only confined, size-limited files; never throws on bad input. */
export function summarizeEvidence(evidenceRows, evidenceRoot) {
  const root = path.resolve(evidenceRoot);
  const files = [], out = { network: null, console: null };
  for (const ev of evidenceRows) {
    const ext = path.extname(ev.rel_path || '').toLowerCase();
    const kind = ext === '.har' ? 'har' : ['.log', '.ndjson', '.txt'].includes(ext) && ev.kind === 'log' ? 'console' : null;
    if (!kind) continue;
    const file = path.resolve(root, ev.rel_path);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { files.push({ name: ev.name, kind, problem: 'missing' }); continue; }
    const st = fs.statSync(file);
    if (st.size > MAX_READ) { files.push({ name: ev.name, kind, problem: 'too_large' }); continue; }
    const text = fs.readFileSync(file, 'utf8');
    files.push({ name: ev.name, kind, bytes: st.size });
    if (kind === 'har') {
      const part = parseHar(text);
      // every failure and console sample says which evidence item it came from
      if (part.failures) part.failures = part.failures.map((f) => ({ ...f, evidenceUid: ev.uid ?? null, evidenceName: ev.name }));
      out.network = mergeNetwork(out.network, part);
    } else {
      const part = parseConsole(text);
      part.samples = part.samples.map((x) => ({ ...x, evidenceUid: ev.uid ?? null, evidenceName: ev.name }));
      out.console = mergeConsole(out.console, part);
    }
  }
  const diagnostics = [];
  if (out.network?.failed) diagnostics.push(`${out.network.failed} network request${out.network.failed === 1 ? '' : 's'} failed or returned an error status`);
  if (out.network?.byStatus?.['5xx']) diagnostics.push(`${out.network.byStatus['5xx']} server error response${out.network.byStatus['5xx'] === 1 ? '' : 's'} (5xx)`);
  if (out.console?.errors) diagnostics.push(`${out.console.errors} console error${out.console.errors === 1 ? '' : 's'}`);
  return { files, ...out, diagnostics, verdictImpact: 'none' };
}
const mergeNetwork = (a, b) => (!a || a.format === 'invalid' ? b : b.format === 'invalid' ? a
  : { ...a, total: a.total + b.total, analysed: a.analysed + b.analysed, failed: a.failed + b.failed, slow: a.slow + b.slow,
    byStatus: Object.fromEntries(Object.keys(a.byStatus).map((k) => [k, a.byStatus[k] + b.byStatus[k]])),
    failures: [...a.failures, ...b.failures].slice(0, 20), slowest: [...a.slowest, ...b.slowest].sort((x, y) => y.ms - x.ms).slice(0, 5) });
const mergeConsole = (a, b) => (!a ? b : { format: a.format === b.format ? a.format : 'mixed', lines: a.lines + b.lines, errors: a.errors + b.errors,
  warnings: a.warnings + b.warnings, samples: [...a.samples, ...b.samples].slice(0, 25) });
