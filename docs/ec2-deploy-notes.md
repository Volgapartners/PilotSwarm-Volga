# PilotSwarm EC2 Deploy Notes

## Neon + Duroxide Advisory Lock Issue (2026-04-16)

**Problem**: PilotSwarm portal hangs on startup when WORKERS > 1 with Neon PostgreSQL (pooler endpoint).

**Root cause**: Each `PilotSwarmWorker.start()` calls `PostgresProvider.connectWithSchema()` which acquires a `pg_advisory_lock` for schema migration safety. When 4 workers start sequentially, worker 1 holds the lock while workers 2-4 block waiting for it. On Neon's PgBouncer (transaction pooling mode), session-scoped advisory locks misbehave -- the lock holder's connection can get reassigned, causing indefinite hangs.

**Symptoms**:
- Portal process starts, serves static files, but `/api/bootstrap` never responds
- `journalctl` shows: `slow statement: SELECT pg_advisory_lock($1)` with 40+ second elapsed times
- Stale PG backends accumulate in Neon (`pg_stat_activity` shows 20+ idle connections)
- Killing portal with SIGKILL leaves stale advisory locks that block the next startup

**Fix**: Set `WORKERS=1` in systemd override. Single worker avoids concurrent advisory lock contention.

**Alternative**: Use Neon direct endpoint (remove `-pooler` from hostname) which supports session-scoped advisory locks properly. Not tested with WORKERS=4 yet.

**Upstream fix needed**: `connectWithSchema` should run migration only once and share the provider across workers, or use `pg_advisory_xact_lock` (transaction-scoped) instead of session-scoped `pg_advisory_lock`.

## Codex Subscription Topology

For a subscription-backed Codex deployment, do not use the portal's embedded
worker as the Codex executor. Run one dedicated headless worker for each
private `CODEX_HOME`, and set the portal to client-only:

Run the worker and portal as different Unix users. Only the worker user may
read `CODEX_HOME`; grant both users read access to the checkout and provider
catalog through a shared group or ACL.

```bash
# Dedicated worker environment
CODEX_HOME=/home/<worker-user>/.codex
CODEX_BINARY_PATH=/path/to/codex
PS_MODEL_PROVIDERS_PATH=/etc/<service-name>/model_providers.json

# Portal environment
WORKERS=0
PS_MODEL_PROVIDERS_PATH=/etc/<service-name>/model_providers.json
```

Both services should use the same non-root service account and shared
PostgreSQL configuration. The headless worker must register all custom tool
handlers; the portal does not inherit that process-local registry. For this
topology, `WORKERS=0` supersedes the general `WORKERS=1` Neon workaround above
because the worker runs as a separate service.

See [Codex Runtime](./codex-runtime.md#dedicated-worker-and-client-only-portal-with-systemd)
for complete unit examples and rollback guidance.

## Operational Notes

- Always stop services before DB maintenance -- SIGKILL'd processes leave stale advisory locks
- After any unclean shutdown, nuke all backends:
  ```sql
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid != pg_backend_pid();
  ```
- Deploy path: `/home/ubuntu/pilotswarm` (clean checkout)
- Config path: `/etc/pilotswarm/` (portal.env, mcp.env, model_providers.json)
- Portal systemd override: `WORKERS=1` in `/etc/systemd/system/pilotswarm-portal.service.d/override.conf`
