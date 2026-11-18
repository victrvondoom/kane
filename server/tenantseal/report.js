// TenantSeal report: a machine-readable record and a human-readable summary, written side by side.
// The record carries a SHA-256 digest of its canonical JSON so a later copy can be checked for modification.
// Credentials are never written: they are not part of the scan object, and only relative paths are emitted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ENGINE_LABEL = (scan) => (scan.engineKind === 'simulated' ? 'SIMULATED (test fixture, not Kane evidence)' : `Kane CLI ${scan.engine?.version ?? ''}`.trim());

export function toMarkdown(scan) {
  const lines = [];
  lines.push(`# TenantSeal report: ${scan.verdict}`, '');
  lines.push(`- Scan: \`${scan.scanId}\``);
  lines.push(`- Target: ${scan.target}`);
  lines.push(`- Engine: ${ENGINE_LABEL(scan)}`);
  lines.push(`- Application revision (source fingerprint): \`${scan.appRevision ?? 'n/a'}\``);
  lines.push(`- Release blocking: **${scan.releaseBlocking ? 'yes' : 'no'}**`);
  lines.push(`- Run budget used: ${scan.budget ? `${scan.budget.used} of ${scan.budget.max}` : 'n/a'}`, '');
  if (scan.resource) lines.push('## Planted record', '', `- Record id: \`${scan.resource.id}\``, `- Canary (fresh for this scan): \`${scan.canary}\``, '');
  if (scan.reasons?.length) { lines.push('## Reasons', ''); for (const r of scan.reasons) lines.push(`- ${r}`); lines.push(''); }
  if (scan.discovery) {
    lines.push('## Discovered routes', '', '| Method | Route | Found by | Observations | Carries canary |', '| --- | --- | --- | --- | --- |');
    for (const r of scan.discovery.routes) lines.push(`| ${r.method} | \`${r.template}\` | ${r.kind} | ${r.observations} | ${r.carriesCanary ? 'yes' : 'no'} |`);
    if (!scan.discovery.routes.length) lines.push('| — | none | — | — | — |');
    lines.push('');
  }
  if (scan.checks?.length) {
    lines.push('## Checks', '', '| Check | Verdict | Evidence summary |', '| --- | --- | --- |');
    for (const c of scan.checks) lines.push(`| ${c.id} | **${c.verdict}** | ${String(c.reason || '').replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  if (scan.runs?.length) {
    lines.push('## Kane executions', '', '| Label | Run | Status | Duration (ms) | Credits (measured) | Evidence files |', '| --- | --- | --- | --- | --- | --- |');
    const credits = (r) => (scan.engineKind === 'simulated' ? 'n/a (simulated)' : (r.creditsConsumed ?? 'not reported by Kane'));
    for (const r of scan.runs) lines.push(`| ${r.label} | \`${r.runId ?? '—'}\` | ${r.runStatus}${r.errorKind ? ' (' + r.errorKind + ')' : ''} | ${r.durationMs} | ${credits(r)} | ${r.evidenceCount} |`);
    lines.push('');
  }
  if (scan.trusted) {
    const same = scan.trusted.before.configSha === scan.trusted.after.configSha && scan.trusted.before.scannerSha === scan.trusted.after.scannerSha;
    lines.push('## Trusted specification', '', `- Unchanged during the scan: **${same ? 'yes' : 'NO'}**`, `- Config SHA-256: \`${scan.trusted.after.configSha}\``, `- Scanner SHA-256: \`${scan.trusted.after.scannerSha}\``, '');
  }
  return lines.join('\n') + '\n';
}

/** Write scan.json and report.md into scanDir. Returns the relative paths and the record digest. */
export function writeReport(scanDir, scan) {
  const canonical = JSON.stringify(scan, null, 2) + '\n';
  const digest = crypto.createHash('sha256').update(canonical).digest('hex');
  const jsonFile = path.join(scanDir, 'scan.json');
  const mdFile = path.join(scanDir, 'report.md');
  fs.writeFileSync(jsonFile, canonical);
  fs.writeFileSync(mdFile, toMarkdown(scan) + `\nRecord SHA-256: \`${digest}\`\n`);
  return { json: path.relative(process.cwd(), jsonFile).replace(/\\/g, '/'), markdown: path.relative(process.cwd(), mdFile).replace(/\\/g, '/'), digest };
}
