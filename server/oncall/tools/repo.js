// Repository intelligence (read-only): structure, source, search, branches, history, diffs, dependencies, regression candidates.
import fs from 'node:fs';
import path from 'node:path';
import { git, safePath, isDenied, repoInfo, defaultBranch } from '../git.js';
import { ToolError } from './registry.js';

const REF = '^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,120}$';
const S = (o = {}) => ({ type: 'string', ...o });
const lines = (s) => s.split('\n').filter(Boolean);
const guard = (p) => { if (isDenied(p)) throw new ToolError('protected_path', `${p} is a protected path (secrets, data or dependencies) and is not readable through the agent.`); return p; };

export function registerRepoTools(reg, { cfg }) {
  /** Reads follow the incident's worktree once a repair branch exists, so the agent always sees its own changes. */
  const root = (ctx) => ctx.incident?.worktree && fs.existsSync(ctx.incident.worktree) ? ctx.incident.worktree : cfg.repoDir;

  reg.define({ name: 'repo_overview', tier: 'read_only', description: 'Repository identity and layout: remote, default branch, current HEAD, top-level structure with file counts, package scripts and the latest commits. Start here.',
    async handler(ctx) {
      const dir = root(ctx), info = await repoInfo(dir), base = await defaultBranch(cfg.repoDir, cfg.baseBranch);
      const files = lines((await git(dir, ['ls-files'])).stdout).filter((f) => !isDenied(f));
      const tree = {}; for (const f of files) { const top = f.includes('/') ? f.split('/')[0] + '/' : f; tree[top] = (tree[top] || 0) + 1; }
      let pkg = null; try { const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); pkg = { name: p.name, scripts: p.scripts, dependencies: Object.keys(p.dependencies || {}), engines: p.engines }; } catch {}
      const log = lines((await git(dir, ['log', '-n', '8', '--date=iso-strict', '--format=%h %ad %an — %s'])).stdout);
      return { summary: `${info.remote || 'local repository'} @ ${info.head.slice(0, 7)} (${info.branch}), default branch ${base}, ${files.length} tracked files`,
        data: { remote: info.remote, defaultBranch: base, currentBranch: info.branch, head: info.head, workingIn: dir === cfg.repoDir ? 'main checkout (read-only)' : 'incident worktree', trackedFiles: files.length, topLevel: tree, package: pkg, recentCommits: log } };
    } });

  reg.define({ name: 'repo_list_files', tier: 'read_only', description: 'List tracked files under a directory (or matching a substring).',
    input: { type: 'object', properties: { directory: S({ maxLength: 300 }), contains: S({ maxLength: 100 }) } },
    async handler(ctx, { directory = '', contains }) {
      const dir = root(ctx); if (directory) safePath(dir, directory);
      const all = lines((await git(dir, ['ls-files', '--', directory || '.'])).stdout).filter((f) => !isDenied(f) && (!contains || f.includes(contains)));
      return { summary: `${all.length} file(s)`, data: { count: all.length, files: all.slice(0, 400) } };
    } });

  reg.define({ name: 'repo_read_file', tier: 'read_only', description: 'Read a source file (optionally a line range, optionally as of a git ref). Output is line-numbered.',
    input: { type: 'object', required: ['path'], properties: { path: S({ maxLength: 400 }), start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 }, ref: S({ pattern: REF }) } },
    async handler(ctx, { path: rel, start_line = 1, end_line, ref }) {
      const dir = root(ctx); guard(rel); const abs = safePath(dir, rel);
      let text;
      if (ref) text = (await git(dir, ['show', `${ref}:${path.relative(dir, abs)}`])).stdout;
      else { if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new ToolError('not_found', `${rel} does not exist`); if (fs.statSync(abs).size > 2_000_000) throw new ToolError('too_large', `${rel} is larger than 2 MB`); text = fs.readFileSync(abs, 'utf8'); }
      if (text.includes('\0')) throw new ToolError('binary', `${rel} is a binary file`);
      const all = text.split('\n'), end = Math.min(end_line || start_line + 399, all.length, start_line + 599);
      const body = all.slice(start_line - 1, end).map((l, i) => `${String(start_line + i).padStart(5)}  ${l}`).join('\n');
      return { summary: `${rel}${ref ? `@${ref}` : ''} lines ${start_line}–${end} of ${all.length}`, data: body, };
    }, maxOutput: 40000 });

  reg.define({ name: 'repo_search', tier: 'read_only', description: 'Search tracked source code (fixed string by default, or an extended regex). Returns file:line:text matches.',
    input: { type: 'object', required: ['query'], properties: { query: S({ minLength: 2, maxLength: 200 }), path: S({ maxLength: 300 }), regex: { type: 'boolean' }, ignore_case: { type: 'boolean' }, max_results: { type: 'integer', minimum: 1, maximum: 200 } } },
    async handler(ctx, { query, path: p = '.', regex, ignore_case, max_results = 60 }) {
      const dir = root(ctx); safePath(dir, p);
      const r = await git(dir, ['grep', '-n', '-I', '--untracked', '--exclude-standard', regex ? '-E' : '-F', ...(ignore_case ? ['-i'] : []), '-e', query, '--', p], { allowFail: true });
      if (r.code > 1) throw new ToolError('search_failed', r.stderr.trim().split('\n')[0] || 'search failed');
      const hits = lines(r.stdout).filter((l) => !isDenied(l.split(':')[0]));
      return { summary: `${hits.length} match(es) for "${query}"`, data: { total: hits.length, matches: hits.slice(0, max_results).map((l) => l.slice(0, 300)) } };
    } });

  reg.define({ name: 'repo_branches', tier: 'read_only', description: 'Local and remote branches with their latest commit, newest first.',
    async handler(ctx) {
      const out = lines((await git(cfg.repoDir, ['for-each-ref', '--sort=-committerdate', '--count=40', '--format=%(refname:short)\t%(objectname:short)\t%(committerdate:iso-strict)\t%(subject)', 'refs/heads', 'refs/remotes'])).stdout);
      return { summary: `${out.length} branch ref(s)`, data: { defaultBranch: await defaultBranch(cfg.repoDir, cfg.baseBranch), branches: out.map((l) => { const [name, sha, date, subject] = l.split('\t'); return { name, sha, date, subject }; }) } };
    } });

  reg.define({ name: 'repo_log', tier: 'read_only', description: 'Commit history, optionally limited to a path, a ref, or a time window (e.g. since "3 days ago"). Includes the files each commit touched.',
    input: { type: 'object', properties: { path: S({ maxLength: 300 }), ref: S({ pattern: REF }), since: S({ maxLength: 40, pattern: '^[A-Za-z0-9 :.+-]+$' }), limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    async handler(ctx, { path: p, ref, since, limit = 15 }) {
      const dir = root(ctx); if (p) safePath(dir, p);
      const r = await git(dir, ['log', '-n', String(limit), '--date=iso-strict', '--name-only', '--format=%x1e%H%x1f%an%x1f%ad%x1f%s', ...(since ? [`--since=${since}`] : []), ...(ref ? [ref] : []), '--', ...(p ? [p] : [])]);
      const commits = r.stdout.split('\x1e').filter((c) => c.trim()).map((c) => { const [head, ...files] = c.split('\n'); const [sha, author, date, subject] = head.split('\x1f'); return { sha: sha.slice(0, 12), author, date, subject, files: files.filter(Boolean).slice(0, 25) }; });
      return { summary: `${commits.length} commit(s)${p ? ` touching ${p}` : ''}`, data: { commits } };
    } });

  reg.define({ name: 'repo_show_commit', tier: 'read_only', description: 'One commit: message, stats and patch.',
    input: { type: 'object', required: ['sha'], properties: { sha: S({ pattern: REF }) } },
    async handler(ctx, { sha }) {
      const r = await git(root(ctx), ['show', '--stat', '--patch', '--date=iso-strict', '--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B', sha, '--', '.', ':(exclude).env*']);
      return { summary: `commit ${sha}`, data: r.stdout };
    }, maxOutput: 30000 });

  reg.define({ name: 'repo_diff', tier: 'read_only', description: 'Diff between two refs, or — with no arguments during a repair — the full change on the incident branch (committed and uncommitted) against its base.',
    input: { type: 'object', properties: { base: S({ pattern: REF }), head: S({ pattern: REF }), path: S({ maxLength: 300 }), stat_only: { type: 'boolean' } } },
    async handler(ctx, { base, head, path: p, stat_only }) {
      const dir = root(ctx); if (p) safePath(dir, p);
      const inc = ctx.incident;
      if (!base && inc?.worktree) { await git(dir, ['add', '-A', '--intent-to-add', '--', '.', ':(exclude)node_modules'], { allowFail: true }); base = inc.base_sha; }
      const range = base ? (head ? [`${base}..${head}`] : [base]) : ['HEAD~1', 'HEAD'];
      const r = await git(dir, ['diff', stat_only ? '--stat' : '--patch-with-stat', ...range, '--', p || '.']);
      return { summary: `diff ${range.join(' ')}${r.stdout ? '' : ' (no changes)'}`, data: r.stdout || 'No differences.' };
    }, maxOutput: 40000 });

  reg.define({ name: 'repo_dependencies', tier: 'read_only', description: 'Dependency relationships of one JavaScript module: what it imports and which tracked files import it.',
    input: { type: 'object', required: ['path'], properties: { path: S({ maxLength: 400 }) } },
    async handler(ctx, { path: rel }) {
      const dir = root(ctx); guard(rel); const abs = safePath(dir, rel);
      if (!fs.existsSync(abs)) throw new ToolError('not_found', `${rel} does not exist`);
      const src = fs.readFileSync(abs, 'utf8');
      const imports = [...new Set([...src.matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]))];
      const stem = path.basename(rel).replace(/\.[cm]?[jt]sx?$/, '');
      const r = await git(dir, ['grep', '-n', '-I', '-E', '-e', `(from|require\\(|import\\()\\s*['"][^'"]*\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[cm]?js)?['"]`, '--', '.'], { allowFail: true });
      const importedBy = [...new Set(lines(r.stdout).map((l) => l.split(':')[0]).filter((f) => f !== path.relative(dir, abs) && !isDenied(f)))];
      return { summary: `${rel}: ${imports.length} import(s), imported by ${importedBy.length} file(s)`, data: { imports: { internal: imports.filter((i) => i.startsWith('.')), external: imports.filter((i) => !i.startsWith('.')) }, importedBy } };
    } });

  reg.define({ name: 'repo_regression_candidates', tier: 'read_only', description: 'Commits that could have introduced a regression: everything that touched the given paths in a time window, alongside when the linked SHIPPROOF project last passed and first failed.',
    input: { type: 'object', properties: { paths: { type: 'array', items: S({ maxLength: 300 }), maxItems: 10 }, since: S({ maxLength: 40, pattern: '^[A-Za-z0-9 :.+-]+$' }) } },
    async handler(ctx, { paths = [], since = '14 days ago' }) {
      const dir = root(ctx); paths.forEach((p) => safePath(dir, p));
      const r = await git(dir, ['log', '-n', '40', `--since=${since}`, '--date=iso-strict', '--name-only', '--format=%x1e%H%x1f%an%x1f%ad%x1f%s', '--', ...(paths.length ? paths : ['.'])]);
      const commits = r.stdout.split('\x1e').filter((c) => c.trim()).map((c) => { const [head, ...files] = c.split('\n'); const [sha, author, date, subject] = head.split('\x1f'); return { sha: sha.slice(0, 12), author, date, subject, files: files.filter(Boolean).slice(0, 20) }; });
      const pid = ctx.incident?.project_id ?? ctx.session.project_id; let verification = null;
      if (pid && ctx.db.get('SELECT 1 FROM projects WHERE id = ? AND user_id = ?', pid, ctx.user.id)) {
        const q = (st, dirn) => ctx.db.get(`SELECT x.finished_at at, x.criterion_key key FROM results x JOIN runs r ON r.id = x.run_id WHERE r.project_id = ? AND x.status = ? ORDER BY x.id ${dirn} LIMIT 1`, pid, st);
        const lastPass = q('passed', 'DESC');
        const firstFailAfter = lastPass ? ctx.db.get(`SELECT x.finished_at at, x.criterion_key key FROM results x JOIN runs r ON r.id = x.run_id WHERE r.project_id = ? AND x.status = 'failed' AND x.finished_at > ? ORDER BY x.id LIMIT 1`, pid, lastPass.at) : q('failed', 'ASC');
        verification = { lastPass, firstFailureAfterLastPass: firstFailAfter || null };
        for (const c of commits) c.afterLastPass = lastPass ? c.date > lastPass.at : null;
      }
      return { summary: `${commits.length} candidate commit(s) since ${since}`, data: { window: since, commits, verification, note: 'Candidates are correlation only — confirm by reading the diff and reproducing.' } };
    } });
}
