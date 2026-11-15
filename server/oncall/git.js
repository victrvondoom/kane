// Controlled git access. Every invocation is an argv array (never a shell string) with a fixed set of subcommands.
// Guardrails that hold no matter what the model asks for: work happens only in a per-incident worktree on an
// `oncall/` branch, the default branch is never pushed, and no push is ever forced.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class GitError extends Error { constructor(message, detail = {}) { super(message); Object.assign(this, detail); } }

const baseEnv = (extra = {}) => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', LC_ALL: 'C', ...extra });
export function git(cwd, args, { env = {}, timeout = 60000, maxBuffer = 8 * 1024 * 1024, allowFail = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', '-c', 'advice.detachedHead=false', ...args], { cwd, env: baseEnv(env), timeout, maxBuffer, signal }, (err, stdout, stderr) => {
      const out = { code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) };
      if (err && !allowFail) return reject(new GitError(`git ${args[0]} failed: ${(out.stderr || err.message).trim().split('\n').slice(-3).join(' ')}`, out));
      resolve(out);
    });
  });
}
const line = async (cwd, args) => (await git(cwd, args, { allowFail: true })).stdout.trim();

/** Resolve a path the model supplied to a location strictly inside `root` (symlink escapes included). */
export function safePath(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new GitError('A relative file path is required');
  const abs = path.resolve(root, rel), base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new GitError(`Path escapes the repository: ${rel}`);
  let probe = abs; while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe), realBase = fs.realpathSync(base);
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new GitError(`Path escapes the repository: ${rel}`);
  return abs;
}
// Never readable or writable through the agent, whatever the permission level.
const DENY = [/(^|\/)\.git(\/|$)/, /(^|\/)\.env(\.|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)data(\/|$)/, /\.(pem|key|p12|pfx|keystore)$/i, /(^|\/)id_(rsa|ed25519|ecdsa)/, /(^|\/)\.npmrc$/, /(^|\/)\.testmuai(\/|$)/];
export const isDenied = (rel) => { const p = String(rel).replace(/\\/g, '/').replace(/^\.\//, ''); return DENY.some((rx) => rx.test(p)) && !/(^|\/)\.env\.example$/.test(p); };

export async function repoInfo(repoDir) {
  const inside = await line(repoDir, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') throw new GitError(`${repoDir} is not a git repository`);
  const remoteUrl = await line(repoDir, ['remote', 'get-url', 'origin']);
  return { root: await line(repoDir, ['rev-parse', '--show-toplevel']), head: await line(repoDir, ['rev-parse', 'HEAD']), branch: await line(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    hasRemote: !!remoteUrl, remote: remoteUrl.replace(/(:\/\/)[^@/]*@/, '$1') };
}
/** The repository's real default branch: operator override, then the remote's HEAD, then local convention. */
export async function defaultBranch(repoDir, override = '') {
  if (override) return override;
  const sym = await line(repoDir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (sym) return sym.replace(/^origin\//, '');
  const remote = await git(repoDir, ['ls-remote', '--symref', 'origin', 'HEAD'], { allowFail: true, timeout: 20000 });
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(remote.stdout);
  if (m) return m[1];
  for (const b of ['main', 'master']) if (await line(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  return line(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}
export function parseGithubRepo(remoteUrl) {
  const m = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(remoteUrl || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}
export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'fix';
/** Give a worktree the main checkout's installed dependencies (a symlink that is never staged or committed). */
const linkModules = (repoDir, dir) => {
  const nm = path.join(repoDir, 'node_modules'), to = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm) || fs.existsSync(to)) return;
  try {
    fs.symlinkSync(nm, to, 'dir');
    // `node_modules/` in .gitignore matches directories only, not this symlink: exclude it locally as well.
    const ex = path.join(repoDir, '.git', 'info', 'exclude');
    if (fs.existsSync(path.dirname(ex)) && !(fs.existsSync(ex) && /^node_modules$/m.test(fs.readFileSync(ex, 'utf8')))) fs.appendFileSync(ex, '\nnode_modules\n');
  } catch {}
};

/** Create the incident's isolated worktree on a fresh `oncall/` branch cut from the default branch. */
export async function createWorktree({ repoDir, worktreesDir, branch, base, prefix = 'oncall/' }) {
  if (!branch.startsWith(prefix) || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) throw new GitError(`Branch must start with ${prefix}`);
  if (branch === base) throw new GitError('Refusing to work on the default branch');
  await git(repoDir, ['fetch', '--quiet', 'origin', base], { allowFail: true, timeout: 60000 });
  const start = (await line(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])) ? `origin/${base}`
    : (await line(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`])) ? base : 'HEAD';
  if (await line(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) throw new GitError(`Branch ${branch} already exists`);
  const dir = path.join(worktreesDir, branch.replace(/[^A-Za-z0-9._-]+/g, '_'));
  fs.mkdirSync(worktreesDir, { recursive: true });
  await git(repoDir, ['worktree', 'add', '--quiet', '-b', branch, dir, start]);
  linkModules(repoDir, dir);
  return { dir, branch, base, baseSha: await line(dir, ['rev-parse', 'HEAD']), startedFrom: start };
}
/** A throwaway detached checkout of `sha`, used to run a regression test against the code before the fix. */
export async function scratchWorktree({ repoDir, worktreesDir, sha, name }) {
  const dir = path.join(worktreesDir, name);
  fs.mkdirSync(worktreesDir, { recursive: true });
  await git(repoDir, ['worktree', 'add', '--quiet', '--detach', dir, sha]);
  linkModules(repoDir, dir);
  return { dir, remove: async () => { await git(repoDir, ['worktree', 'remove', '--force', dir], { allowFail: true }); fs.rmSync(dir, { recursive: true, force: true }); } };
}
export const removeWorktree = async (repoDir, dir) => { await git(repoDir, ['worktree', 'remove', '--force', dir], { allowFail: true }); };
/** Hash of the exact content a check ran against: staged + unstaged + untracked, without touching the index. */
export async function treeSha(dir) {
  const tmp = path.join(dir, '..', `.idx-${path.basename(dir)}-${process.pid}-${Date.now()}`);
  try {
    const env = { GIT_INDEX_FILE: tmp };
    const realIndex = (await line(dir, ['rev-parse', '--git-path', 'index']));
    try { fs.copyFileSync(path.resolve(dir, realIndex), tmp); } catch {}
    await git(dir, ['add', '-A', '--', '.', ':(exclude)node_modules'], { env });
    return (await git(dir, ['write-tree'], { env })).stdout.trim();
  } finally { fs.rmSync(tmp, { force: true }); }
}
export const headSha = (dir) => line(dir, ['rev-parse', 'HEAD']);
export async function status(dir) {
  const out = (await git(dir, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.split('\n').filter(Boolean).filter((l) => !/ node_modules$/.test(l));
  return out.map((l) => ({ state: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
}

// ---- integrity guard: a fix may not make checks pass by weakening them ----
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP_MARK = /\b(?:test|it|describe)\.(?:skip|only|todo)\s*\(|\bx(?:it|describe|test)\s*\(|\{\s*skip\s*:|\bskip\s*:\s*(?:true|['"`])|@pytest\.mark\.skip|\.skip\(\)/;
export async function integrityViolations(dir, base) {
  const violations = [];
  await git(dir, ['add', '-A', '--intent-to-add', '--', '.', ':(exclude)node_modules'], { allowFail: true });
  const names = (await git(dir, ['diff', '--name-status', base, '--', '.'])).stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
  for (const [st, a, b] of names) {
    const p = b || a;
    if (isDenied(p)) violations.push(`${p}: protected path (secrets, data or tooling state) may not be changed`);
    if (st.startsWith('D') && TEST_FILE.test(a)) violations.push(`${a}: deleting a test file is not allowed`);
    if (/(^|\/)\.github\/workflows\//.test(p)) violations.push(`${p}: CI workflow changes need a human`);
  }
  const patch = (await git(dir, ['diff', '--unified=0', base, '--', '.'])).stdout;
  let file = '';
  for (const l of patch.split('\n')) {
    if (l.startsWith('+++ b/')) file = l.slice(6);
    else if (l.startsWith('+') && !l.startsWith('+++') && TEST_FILE.test(file) && SKIP_MARK.test(l)) violations.push(`${file}: adds a skip/only marker (${l.slice(1).trim().slice(0, 80)})`);
  }
  return [...new Set(violations)];
}
export async function commitAll(dir, message, author) {
  await git(dir, ['add', '-A', '--', '.', ':(exclude)node_modules']);
  const staged = (await git(dir, ['diff', '--cached', '--name-only'])).stdout.split('\n').filter(Boolean);
  if (!staged.length) throw new GitError('Nothing to commit: the working tree matches HEAD');
  await git(dir, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '--quiet', '--no-verify', '-m', message]);
  return { sha: await headSha(dir), files: staged };
}
/** Push the incident branch. Never the default branch, never forced; the token (if any) travels in the environment, not argv. */
export async function pushBranch({ dir, branch, base, prefix = 'oncall/', token = '' }) {
  if (!branch.startsWith(prefix) || branch === base) throw new GitError('Refusing to push: only on-call feature branches can be pushed');
  const current = await line(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch) throw new GitError(`Refusing to push: worktree is on ${current}, expected ${branch}`);
  const env = token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {};
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await git(dir, ['push', '--quiet', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { env, allowFail: true, timeout: 120000 });
    if (last.code === 0) return { pushed: true, sha: await headSha(dir), attempts: attempt + 1 };
    if (!/timed? ?out|could not resolve|connection (reset|refused)|early eof|unexpected disconnect|RPC failed|50\d/i.test(last.stderr)) break; // only network errors are retried
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw new GitError(`git push failed: ${last.stderr.trim().split('\n').slice(-3).join(' ')}`);
}
