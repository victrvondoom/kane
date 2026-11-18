// Multi-Engine Isolated Worker Bridge
// Executes isolated Python engine workers (Gatekeeper, Playtest, OQED, SAE)
// using structured JSON protocol over stdin/stdout with timeout and cancellation.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Redact known secret keys and token formats
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9_\-\.]{20,}/gi,
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?([A-Za-z0-9_\-\.]{16,})["']?/gi,
  /ghp_[A-Za-z0-9]{36}/gi,
  /sk-[A-Za-z0-9_\-]{32,}/gi,
];

export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const rx of SECRET_PATTERNS) {
    out = out.replace(rx, (m) => (m.startsWith('Bearer') ? 'Bearer «redacted»' : '«redacted»'));
  }
  return out;
}

/**
 * Execute an engine worker subprocess with structured JSON request and response.
 */
export async function invokeEngineWorker({
  engine,             // 'gatekeeper' | 'playtest' | 'oqed' | 'sae'
  scriptPath,         // Path to Python worker script
  action,             // Action name
  payload = {},       // Input JSON payload
  workspaceDir = ROOT,
  timeoutMs = 60000,
  correlationId = null,
  signal = null,
  env = {},
}) {
  const executionId = crypto.randomUUID();
  const corrId = correlationId || executionId;
  const startedAt = Date.now();

  const req = {
    executionId,
    correlationId: corrId,
    engine,
    action,
    workspaceDir,
    payload,
    timestamp: new Date().toISOString(),
  };

  const reqJson = JSON.stringify(req);

  return new Promise((resolve) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;

    // Use Python from uv if available, or system python
    const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
    const args = [scriptPath];

    const childEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      NODE_ENV: process.env.NODE_ENV || 'production',
      SHIPPROOF_WORKSPACE: workspaceDir,
      ...env,
    };

    let child;
    try {
      child = spawn(pythonExe, args, {
        cwd: workspaceDir,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      return resolve({
        ok: false,
        executionId,
        correlationId: corrId,
        engine,
        action,
        error: `Could not start ${engine} worker: ${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    }

    const kill = () => {
      if (!child?.pid) return;
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      kill();
      finish({
        ok: false,
        error: `${engine} worker timed out after ${timeoutMs}ms`,
        code: 'TIMEOUT',
      });
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      kill();
      finish({
        ok: false,
        error: `${engine} worker execution cancelled`,
        code: 'CANCELLED',
      });
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);

      resolve({
        executionId,
        correlationId: corrId,
        engine,
        action,
        durationMs: Date.now() - startedAt,
        stderr: redactSecrets(stderrBuffer.trim()),
        ...result,
      });
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      finish({
        ok: false,
        error: `Worker process error: ${err.message}`,
        code: 'SPAWN_ERROR',
      });
    });

    child.on('close', (code) => {
      if (settled) return;

      const trimmedOut = stdoutBuffer.trim();
      let parsed = null;

      try {
        parsed = JSON.parse(trimmedOut);
      } catch (err) {
        // Find last JSON block if diagnostics precede stdout
        const lastBrace = trimmedOut.lastIndexOf('}');
        const firstBrace = trimmedOut.indexOf('{');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          try {
            parsed = JSON.parse(trimmedOut.slice(firstBrace, lastBrace + 1));
          } catch {}
        }
      }

      if (code !== 0 && (!parsed || parsed.ok !== true)) {
        return finish({
          ok: false,
          exitCode: code,
          error: parsed?.error || `Worker exited with non-zero code ${code}`,
          diagnostics: redactSecrets(stderrBuffer.slice(-2000)),
          data: parsed?.data || null,
        });
      }

      if (parsed) {
        finish({
          ok: parsed.ok ?? true,
          exitCode: code,
          data: parsed.data !== undefined ? parsed.data : parsed,
          error: parsed.error || null,
        });
      } else {
        finish({
          ok: code === 0,
          exitCode: code,
          error: code === 0 ? null : 'Worker produced unparseable stdout',
          rawOutput: redactSecrets(trimmedOut.slice(0, 1000)),
        });
      }
    });

    // Send payload to worker stdin
    try {
      child.stdin.write(reqJson);
      child.stdin.end();
    } catch (writeErr) {
      finish({
        ok: false,
        error: `Failed to write input to worker stdin: ${writeErr.message}`,
      });
    }
  });
}
