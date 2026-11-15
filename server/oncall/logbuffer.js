// In-memory ring buffer of the server's structured log lines, so the on-call agent can inspect real service logs.
export function createLogBuffer(max = 3000) {
  const lines = []; let seq = 0;
  return {
    push(entry) { lines.push({ seq: ++seq, ...entry }); if (lines.length > max) lines.splice(0, lines.length - max); },
    query({ level, contains, sinceMs, path, minStatus, limit = 100 } = {}) {
      const since = sinceMs ? Date.now() - sinceMs : 0, needle = contains ? String(contains).toLowerCase() : null;
      const out = lines.filter((l) => (!level || l.level === level) && (!since || Date.parse(l.ts) >= since) && (!path || String(l.path || '').includes(path))
        && (!minStatus || (l.status || 0) >= minStatus) && (!needle || JSON.stringify(l).toLowerCase().includes(needle)));
      return { total: out.length, lines: out.slice(-Math.min(Math.max(limit, 1), 500)) };
    },
    size: () => lines.length,
  };
}
