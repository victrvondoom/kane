// TenantSeal verdict rules. Pure functions over observed evidence; no I/O, so every rule is unit-testable.
// The rules that matter most:
//   - a canary seen by another tenant or by an anonymous visitor is a LEAK, whatever the status code says;
//   - a tamper token seen by the owner after the second tenant's write is a confirmed TAMPERED write;
//   - a failed sign-in never proves that a route is secure (INCONCLUSIVE);
//   - an owner who cannot read their own record is OWNER_LOCKED_OUT and blocks release;
//   - missing evidence, timeouts and unreachable targets are never BLOCKED or SEALED.
import { observedAt } from './har.js';

export const CHECK = Object.freeze({
  BLOCKED: 'BLOCKED', LEAK: 'LEAK', TAMPERED: 'TAMPERED', OWNER_OK: 'OWNER_OK', OWNER_LOCKED_OUT: 'OWNER_LOCKED_OUT',
  INCONCLUSIVE: 'INCONCLUSIVE', ERROR: 'ERROR', NOT_APPLICABLE: 'NOT_APPLICABLE',
});
export const SCAN = Object.freeze({
  SEALED: 'SEALED', SIMULATED_SEALED: 'SIMULATED_SEALED', LEAKING: 'LEAKING', INCONCLUSIVE: 'INCONCLUSIVE',
  ERROR: 'ERROR', BLOCKED_CONFIGURATION: 'BLOCKED_CONFIGURATION',
});

const ENVIRONMENT_STATUSES = new Set(['error', 'timeout', 'cancelled', 'not_run']);

/** Shared gate for every probe: the browser run itself must have completed. */
function runProblem(probe) {
  if (!probe) return { verdict: CHECK.INCONCLUSIVE, reason: 'probe was not executed' };
  if (ENVIRONMENT_STATUSES.has(probe.runStatus)) {
    return { verdict: CHECK.ERROR, reason: `browser run ${probe.runStatus}${probe.errorKind ? ' (' + probe.errorKind + ')' : ''}: ${probe.reason || 'no detail'}` };
  }
  if (probe.runStatus === 'failed' && !probe.identityFailed) return { verdict: CHECK.INCONCLUSIVE, reason: `browser run reported a failure: ${probe.reason || 'no detail'}` };
  return null;
}

/** Identity must be established for a signed-in persona. An unverified session is never treated as that persona. */
function identityProblem(probe, expectedIdentity) {
  if (!expectedIdentity) return null; // anonymous persona: no session is required, and none may exist
  const obs = probe.identity?.observed ?? null;
  if (probe.identityFailed || obs !== expectedIdentity) {
    return { verdict: CHECK.INCONCLUSIVE, reason: `identity not established for ${expectedIdentity} (observed ${obs ?? 'no session'})` };
  }
  return null;
}

/**
 * Read check: can this persona see the resource at pathname?
 * probe: { runStatus, errorKind, reason, identity: {observed}, identityFailed, entries: HAR entries of that run }
 */
export function classifyRead({ probe, origin, pathname, canary, expectedIdentity = null }) {
  const rp = runProblem(probe); if (rp) return { ...rp, exposed: null };
  const ip = identityProblem(probe, expectedIdentity); if (ip) return { ...ip, exposed: null };
  const obs = observedAt(probe.entries, origin, pathname, 'GET');
  if (!obs.length) return { verdict: CHECK.INCONCLUSIVE, reason: `route ${pathname} was not observed in the browser run`, exposed: null };
  const leaked = obs.find((e) => e.body.includes(canary));
  if (leaked) return { verdict: CHECK.LEAK, reason: `canary visible at ${pathname} (HTTP ${leaked.status}) to ${expectedIdentity ?? 'an anonymous visitor'}`, exposed: true, status: leaked.status };
  const status = obs.at(-1).status;
  return { verdict: CHECK.BLOCKED, reason: `canary not visible at ${pathname} (HTTP ${status})`, exposed: false, status };
}

/**
 * Tamper check: the second persona attempts a write. The result is judged by the owner's view afterwards, not by
 * the write's HTTP status: a 200 or 303 from the write proves nothing if the record is unchanged.
 *   attempt: probe for the second persona's write attempt
 *   owner:   probe for the owner's read after the attempt
 */
export function classifyTamper({ attempt, owner, origin, writePath, method, readPath, canary, tamperToken, secondIdentity, ownerIdentity }) {
  const rp = runProblem(attempt); if (rp) return rp;
  const ip = identityProblem(attempt, secondIdentity); if (ip) return ip;
  const sent = observedAt(attempt.entries, origin, writePath, method);
  if (!sent.length) return { verdict: CHECK.INCONCLUSIVE, reason: `write attempt ${method} ${writePath} was not observed in the browser run` };
  const orp = runProblem(owner); if (orp) return { ...orp, reason: `owner re-check: ${orp.reason}` };
  const oip = identityProblem(owner, ownerIdentity); if (oip) return { ...oip, reason: `owner re-check: ${oip.reason}` };
  const seen = observedAt(owner.entries, origin, readPath, 'GET');
  if (!seen.length) return { verdict: CHECK.INCONCLUSIVE, reason: `owner re-check did not observe ${readPath}` };
  if (seen.some((e) => e.body.includes(tamperToken))) {
    return { verdict: CHECK.TAMPERED, reason: `owner sees the tamper token written by ${secondIdentity} at ${writePath}` };
  }
  if (seen.some((e) => e.body.includes(canary))) {
    return { verdict: CHECK.BLOCKED, reason: `write by ${secondIdentity} to ${writePath} did not change the owner's record` };
  }
  return { verdict: CHECK.INCONCLUSIVE, reason: 'owner re-check did not show the record content; integrity unknown' };
}

/** Owner control: after all negative probes the owner must still reach the record and see its content. */
// Access and integrity are separate facts: the owner may read the record (OWNER_OK) even when its content was
// tampered with; integrity is judged by classifyTamper. `markers` are the content strings the owner may see.
export function classifyOwner({ probe, origin, pathname, markers, ownerIdentity, denialStatuses = [401, 403, 404] }) {
  const rp = runProblem(probe); if (rp) return rp;
  const ip = identityProblem(probe, ownerIdentity); if (ip) return { ...ip, verdict: CHECK.INCONCLUSIVE };
  const obs = observedAt(probe.entries, origin, pathname, 'GET');
  if (!obs.length) return { verdict: CHECK.INCONCLUSIVE, reason: `owner did not observe ${pathname}` };
  const last = obs.at(-1);
  if (last.status === 200 && markers.some((m) => last.body.includes(m))) return { verdict: CHECK.OWNER_OK, reason: `owner can read ${pathname}` };
  if (denialStatuses.includes(last.status)) return { verdict: CHECK.OWNER_LOCKED_OUT, reason: `owner denied at ${pathname} (HTTP ${last.status}); fixing the policy must not lock the owner out` };
  return { verdict: CHECK.INCONCLUSIVE, reason: `owner read of ${pathname} returned HTTP ${last.status} without the canary` };
}

/**
 * Aggregate every check into one scan verdict.
 *   checks: [{ id, kind: 'plant'|'read'|'tamper'|'owner', route, actor, verdict, reason, errorKind }]
 *   routes: discovered route templates that must each have a final verdict
 */
export function aggregateScan({ checks, routes, engine, configValid = true, configReason = '' }) {
  const sealedLabel = engine === 'simulated' ? SCAN.SIMULATED_SEALED : SCAN.SEALED;
  if (!configValid) return { verdict: SCAN.BLOCKED_CONFIGURATION, releaseBlocking: true, reasons: [configReason] };
  const v = (k) => checks.filter((c) => c.verdict === k);
  const plant = checks.find((c) => c.kind === 'plant');
  if (!plant || plant.verdict !== CHECK.OWNER_OK) {
    const kind = plant?.verdict === CHECK.ERROR ? SCAN.ERROR : SCAN.INCONCLUSIVE;
    return { verdict: kind, releaseBlocking: true, reasons: [plant ? `plant: ${plant.reason}` : 'the planted record was not created'] };
  }
  if (v(CHECK.LEAK).length || v(CHECK.TAMPERED).length) {
    const reasons = [...v(CHECK.LEAK), ...v(CHECK.TAMPERED)].map((c) => `${c.id}: ${c.reason}`);
    return { verdict: SCAN.LEAKING, releaseBlocking: true, reasons };
  }
  if (v(CHECK.OWNER_LOCKED_OUT).length) {
    return { verdict: SCAN.INCONCLUSIVE, releaseBlocking: true, reasons: v(CHECK.OWNER_LOCKED_OUT).map((c) => `${c.id}: ${c.reason}`) };
  }
  const reasons = [];
  if (!routes.length) return { verdict: SCAN.INCONCLUSIVE, releaseBlocking: true, reasons: ['discovery found no related routes; an empty route set is not evidence of safety'] };
  const covered = new Set(checks.filter((c) => c.route).map((c) => c.route));
  const uncovered = routes.filter((r) => !covered.has(r));
  if (uncovered.length) reasons.push(`routes without a final verdict: ${uncovered.join(', ')}`);
  if (!checks.some((c) => c.kind === 'owner' && c.verdict === CHECK.OWNER_OK)) reasons.push('owner control did not succeed');
  const errors = checks.filter((c) => c.verdict === CHECK.ERROR);
  if (errors.length) return { verdict: SCAN.ERROR, releaseBlocking: true, reasons: [...reasons, ...errors.map((c) => `${c.id}: ${c.reason}`)] };
  const incomplete = checks.filter((c) => c.verdict === CHECK.INCONCLUSIVE);
  if (incomplete.length || reasons.length) {
    return { verdict: SCAN.INCONCLUSIVE, releaseBlocking: true, reasons: [...reasons, ...incomplete.map((c) => `${c.id}: ${c.reason}`)] };
  }
  const allowed = new Set([CHECK.BLOCKED, CHECK.OWNER_OK, CHECK.NOT_APPLICABLE]);
  if (checks.every((c) => allowed.has(c.verdict))) {
    return { verdict: sealedLabel, releaseBlocking: false, reasons: [`${v(CHECK.BLOCKED).length} denied probes, owner access intact`] };
  }
  return { verdict: SCAN.INCONCLUSIVE, releaseBlocking: true, reasons: ['unclassified check outcome'] };
}
