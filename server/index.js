import fs from 'node:fs';
// Minimal .env loader (no dependency); real environment variables win.
if (fs.existsSync('.env')) for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { createApp } = await import('./app.js');
const { kaneStatus } = await import('./kane.js');
const { app, shutdown } = createApp();
const port = Number(process.env.PORT) || 4000;
const server = app.listen(port, async () => {
  console.log(`SHIPPROOF listening on http://localhost:${port}`);
  const k = await kaneStatus();
  console.log(`Kane CLI: ${k.installed ? k.version : 'NOT INSTALLED'} · auth: ${k.auth} · ${k.detail}`);
});

let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  if (closing) return; closing = true;
  console.log(`${sig} received — draining`);
  server.close();
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(1), 15000).unref(); // hard stop if draining hangs
  await shutdown();
  process.exit(0);
});
