// Project Workspace Isolation Manager
// Enforces strict tenant and workspace boundaries.
// Every project workspace is restricted to an authorized path with canonical resolution
// and symlink traversal guards.
import fs from 'node:fs';
import path from 'node:path';

export class WorkspaceError extends Error {
  constructor(message, code = 'WORKSPACE_ERROR') {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

/**
 * Resolve and verify the isolated workspace directory for a project.
 */
export function getProjectWorkspace({ db, projectId, dataDir, customPath = null }) {
  if (!projectId || !Number.isInteger(Number(projectId))) {
    throw new WorkspaceError('Valid integer projectId is required', 'INVALID_PROJECT_ID');
  }
  const pid = Number(projectId);

  // Check if workspace record exists in database
  let row = db.get('SELECT * FROM project_workspaces WHERE project_id = ?', pid);
  let wsPath;

  if (row) {
    wsPath = path.resolve(row.workspace_path);
  } else {
    // Default isolated path under dataDir/workspaces/project-<pid>
    wsPath = customPath
      ? path.resolve(customPath)
      : path.resolve(dataDir, 'workspaces', `project-${pid}`);

    fs.mkdirSync(wsPath, { recursive: true });
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO project_workspaces (project_id, workspace_path, is_isolated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET workspace_path = excluded.workspace_path, updated_at = excluded.updated_at`,
      pid,
      wsPath,
      1,
      now,
      now
    );
  }

  // Ensure workspace exists
  if (!fs.existsSync(wsPath)) {
    fs.mkdirSync(wsPath, { recursive: true });
  }

  return {
    projectId: pid,
    path: wsPath,
    canonicalPath: fs.realpathSync(wsPath),
  };
}

/**
 * Confine a relative path to strictly inside the project's workspace.
 * Throws WorkspaceError if the path attempts traversal (e.g. `../../` or dangling symlinks).
 */
export function safeWorkspacePath(workspaceRoot, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.includes('\0')) {
    throw new WorkspaceError('Valid relative path is required', 'INVALID_PATH');
  }

  const base = path.resolve(workspaceRoot);
  const realBase = fs.existsSync(base) ? fs.realpathSync(base) : base;
  const target = path.resolve(base, relPath);

  // Lexical check
  if (target !== realBase && !target.startsWith(realBase + path.sep)) {
    throw new WorkspaceError(`Path escapes workspace boundary: ${relPath}`, 'PATH_TRAVERSAL');
  }

  // Symlink check on all existing segments
  const segments = path.relative(realBase, target).split(path.sep);
  let cur = realBase;
  for (const seg of segments) {
    cur = path.join(cur, seg);
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) {
        let resolvedTarget;
        try {
          resolvedTarget = fs.realpathSync(cur);
        } catch {
          throw new WorkspaceError(`Broken or dangling symlink escapes workspace: ${relPath}`, 'PATH_TRAVERSAL');
        }
        if (resolvedTarget !== realBase && !resolvedTarget.startsWith(realBase + path.sep)) {
          throw new WorkspaceError(`Symlink points outside workspace: ${relPath}`, 'PATH_TRAVERSAL');
        }
      }
    } catch (e) {
      if (e instanceof WorkspaceError) throw e;
      break; // Non-existent sub-path component is safe to create
    }
  }

  return target;
}

/**
 * Populate a project workspace with starter files if it is empty.
 */
export function seedWorkspaceIfEmpty(workspacePath, templateFiles = {}) {
  const files = fs.readdirSync(workspacePath);
  if (files.length === 0) {
    for (const [rel, content] of Object.entries(templateFiles)) {
      const abs = path.join(workspacePath, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
  }
}
