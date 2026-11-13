# Deployment

SHIPPROOF is one long-lived Node process that spawns Kane CLI (and through it, Chrome). It needs a
persistent disk. It is not suitable for serverless or scale-to-zero hosting.

## Checklist

- [ ] Persistent volume mounted at `DATA_DIR` (database `shipproof.db` + `evidence/`).
- [ ] `LT_USERNAME` / `LT_ACCESS_KEY` supplied as runtime secrets (never in the image or Git).
- [ ] HTTPS in front; `COOKIE_SECURE=1`; `TRUST_PROXY` set to the number of proxy hops.
- [ ] Proxy does not buffer `text/event-stream` (the app sends `X-Accel-Buffering: no`) and allows long-lived responses.
- [ ] `ALLOW_PRIVATE_TARGETS=0`; container network cannot reach internal services.
- [ ] Health checks: liveness `GET /healthz`, readiness `GET /readyz` (503 while draining or if the DB/volume is unavailable).
- [ ] Stop grace period ≥ 20 s: on `SIGTERM` the server stops accepting runs, stops the browser, records in-flight checks as `interrupted`, closes the DB.
- [ ] Exactly one instance per data volume (the run queue is in-process; SQLite is single-writer).
- [ ] After first deploy: `npm run kane:smoke` inside the container, then check the engine pill reads the real version with no warning.

## Migrations

Applied automatically at start-up, each in a transaction, recorded in `_migrations`. They are additive.
To apply without starting the server:

```bash
npm run migrate
```

## Backup and restore

Online backup (safe while running; uses `VACUUM INTO`):

```bash
npm run backup -- /data/backups/shipproof-$(date +%F).db
```

Also copy `DATA_DIR/evidence/`. To restore: stop the server, replace `DATA_DIR/shipproof.db` with the
backup (remove any `shipproof.db-wal` / `-shm` files), restore `evidence/`, start the server.

## Rollback

1. Take a backup (above) **before** every upgrade.
2. To roll back code only: redeploy the previous image. Migrations are additive, so an older build
   keeps working against a newer schema as long as it does not depend on removed columns (none are removed).
3. If data must go back too: stop, restore the pre-upgrade backup and evidence directory, start the previous image.
