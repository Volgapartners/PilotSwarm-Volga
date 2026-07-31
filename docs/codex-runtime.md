# Codex Runtime

PilotSwarm can run a session through a local `codex app-server` process instead
of the GitHub Copilot SDK. Clients keep using the public PilotSwarm session,
management, orchestration, tool, event, and durability APIs. Runtime selection
happens on the worker from the qualified model provider.

Codex subscription mode uses the worker's existing Codex CLI login. It does not
require an API key.

## Architecture And Data Flow

```text
PilotSwarmClient
  -> durable PilotSwarm orchestration and activities
  -> SessionManager resolves provider:model
     -> github/openai/anthropic provider: Copilot SDK runtime
     -> type=codex provider: CodexRuntimeClient
        -> codex app-server --stdio
        -> Codex model
```

For a Codex-backed turn:

1. The client creates a normal PilotSwarm session with a qualified model such
   as `codex-subscription:gpt-5.6-sol`.
2. The worker's model-provider registry resolves the provider prefix. A
   `type: "codex"` provider selects the Codex runtime; the suffix is passed to
   Codex as the model id.
3. `SessionManager` builds the same effective PilotSwarm prompt and tool set
   used by the durable session.
4. A `CodexRuntimeClient` talks JSON-RPC over stdio to
   `codex app-server --stdio`.
5. PilotSwarm tools are declared through `thread/start.dynamicTools`. Codex
   sends `item/tool/call` server requests back to PilotSwarm, and the worker
   dispatches them to its JavaScript handlers.
6. Plugin MCP servers take a separate path. PilotSwarm safely translates
   `.mcp.json` into Codex-native `config.mcp_servers`; the Codex process owns
   those MCP connections.
7. Assistant, reasoning, tool, error, and idle events flow back through the
   normal PilotSwarm event and CMS surfaces.

Dynamic PilotSwarm tools and Codex-native MCP tools are not interchangeable.
Dynamic tools execute in the PilotSwarm worker and can participate in durable
orchestration. Native MCP tools execute through Codex's MCP support.

## Differences From Copilot

| Surface | Codex status |
|---|---|
| `PilotSwarmClient`, `PilotSwarmSession`, management APIs, named sessions, and model selection | Supported through the same public PilotSwarm APIs. |
| Durable orchestration, timers, checkpoints, session management, events, sub-agents, and worker tools | Supported. |
| PilotSwarm framework/app/agent instructions | Supported as composed text passed to Codex developer instructions. |
| PilotSwarm prompt-layer skill guidance | Supported when PilotSwarm has composed it into the prompt text. |
| Plugin MCP servers | Supported through Codex-native `mcp_servers` after the security translation described below. |
| Copilot SDK hooks | Not invoked on the Codex path. |
| Copilot SDK permission callback (`onPermissionRequest`) | Not bridged to Codex approvals. |
| Direct Copilot SDK `skillDirectories` loading | Not available on Codex. Do not claim native Copilot skill loading for Codex sessions. |
| Arbitrary Codex approval or other app-server server requests | Not bridged. PilotSwarm handles dynamic `item/tool/call`; unsupported server requests receive a method-not-implemented response. |
| Copilot `requiredTool` enforcement | No native Codex equivalent. The value may be forwarded as metadata, but Codex can still choose not to call the tool. |

The practical compatibility boundary is: build applications against
PilotSwarm's public session, orchestration, prompt, and tool surfaces. Do not
depend on Copilot-SDK-only callbacks for a session that may select Codex.

## Requirements

- Node.js 24 or later
- Codex CLI installed on every worker eligible to run a Codex session
- Codex CLI authenticated as the same operating-system user that runs the
  worker
- a private `CODEX_HOME` directory with mode `0700`
- a `type: "codex"` entry in the worker's model-provider catalog
- PostgreSQL for PilotSwarm orchestration and CMS state
- a shared session store when sessions must recover on another host

Codex CLI 0.145.0 is the version currently verified by the PilotSwarm tests.
Treat the PilotSwarm build, Codex CLI version, and provider catalog as one
tested compatibility unit.

## Install And Authenticate

Install the verified CLI on the worker:

```bash
npm install -g @openai/codex@0.145.0
codex --version
```

For a workstation:

```bash
codex login
```

For a headless worker:

```bash
codex login --device-auth
```

Verify as the service account, not as `root`:

```bash
sudo -u <service-user> env \
  CODEX_HOME=/home/<service-user>/.codex \
  CODEX_BINARY_PATH=/path/to/codex \
  /path/to/codex login status
```

Protect the subscription home:

```bash
chmod 700 /home/<service-user>/.codex
```

PilotSwarm never reads, logs, uploads, or snapshots
`CODEX_HOME/auth.json`. Do not copy that file between machines or users.

## Configure The Provider

Copy `.model_providers.example.json` to the local, gitignored
`.model_providers.json`, or set `PS_MODEL_PROVIDERS_PATH` to an external
catalog:

```json
{
  "providers": [
    {
      "id": "codex-subscription",
      "type": "codex",
      "codexHome": "env:CODEX_HOME",
      "codexBinaryPath": "env:CODEX_BINARY_PATH",
      "models": [
        {
          "name": "gpt-5.6-sol",
          "description": "Codex GPT-5.6 Sol",
          "cost": "medium",
          "supportedReasoningEfforts": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultReasoningEffort": "low"
        }
      ]
    }
  ],
  "defaultModel": "codex-subscription:gpt-5.6-sol"
}
```

Set the worker environment:

```bash
CODEX_HOME=/home/<service-user>/.codex
CODEX_BINARY_PATH=/path/to/codex
PS_MODEL_PROVIDERS_PATH=/etc/<service-name>/model_providers.json
```

The checked-in example retains the six Codex CLI 0.145.0 subscription models
and their verified effort lists:

```text
codex-subscription:gpt-5.6-sol
codex-subscription:gpt-5.6-terra
codex-subscription:gpt-5.6-luna
codex-subscription:gpt-5.5
codex-subscription:gpt-5.4
codex-subscription:gpt-5.4-mini
```

The app-server `model/list` response for the installed CLI and authenticated
account is authoritative. Remove unavailable models or efforts from the local
catalog. Restart processes that cache the catalog after changing it.

Create a session with an optional supported reasoning effort:

```ts
const session = await client.createSession({
  model: "codex-subscription:gpt-5.6-sol",
  reasoningEffort: "ultra",
  toolNames: ["get_weather"],
});
```

## Concurrency And Deployment Topology

Concurrency is scoped to a runtime client, not globally:

- each `SessionManager` caches one `CodexRuntimeClient` per `CODEX_HOME`
- each runtime client owns one `codex app-server` child process
- that runtime client has one turn queue, so sessions sharing it are serialized
- another worker or `SessionManager` using the same `CODEX_HOME` creates its own
  app-server process and its own queue

Therefore `one app-server per CODEX_HOME` only means per
`SessionManager`/worker. It is not an operating-system-wide lock.

For subscription mode, use one dedicated Codex-enabled headless worker for
each subscription home. Run the portal and TUI as clients with `WORKERS=0`.
This prevents multiple embedded workers from starting competing app-server
processes and prevents a client host from claiming activities without the
headless worker's process-local custom tools.

```text
Portal/TUI (WORKERS=0)
          |
          v
PostgreSQL/duroxide/CMS <-> dedicated PilotSwarmWorker
                             |
                             v
                    one private CODEX_HOME
                    one codex app-server
```

Do not share a personal Plus/Pro `CODEX_HOME` across unrelated PilotSwarm
users. If multiple Codex workers are intentionally deployed, give each an
appropriately isolated subscription home, the same required tool registry, and
a shared session store.

## Worker Tool Registry Rules

`toolNames` are serializable names, not handlers. Handlers remain process-local
inside each worker registry.

- every worker eligible to claim a session must register every requested
  custom tool with `PilotSwarmWorker.registerTools(...)`
- per-session `worker.setSessionConfig(..., { tools })` only helps a
  co-located, same-process worker
- unresolved `toolNames` produce a warning and remain nonfatal; the session
  starts, but the model cannot call the missing handler
- a portal embedded worker does not inherit the registry of a separate
  headless worker
- `WORKERS=0` is the required portal/TUI setting when a dedicated headless
  worker owns custom tools

Codex fixes dynamic-tool schemas at `thread/start`. Updating a handler refreshes
later calls, but adding or renaming a tool does not add its schema to an
existing Codex thread. Start a new PilotSwarm session after changing tool
schemas or native MCP servers.

## Codex-Native MCP Security Translation

Codex persists native MCP configuration as part of its thread state. PilotSwarm
therefore passes environment-variable names, not resolved secret values, and
drops unsafe forms with a warning.

### HTTP And SSE

| PilotSwarm `.mcp.json` input | Codex-native result |
|---|---|
| Literal `url`, for example `https://<mcp-host>/mcp` | Kept as `url`. |
| `url` containing `${VAR}` anywhere | The entire server is dropped. Codex has no safe `url_env_var` field. |
| `Authorization: Bearer ${TOKEN_VAR}` | `bearer_token_env_var: "TOKEN_VAR"`. |
| Any header whose complete value is `${VAR}` | `env_http_headers.<header>: "VAR"`. |
| Static, non-sensitive header | Kept in `http_headers`. |
| Static sensitive header, including authorization, cookie, API-key, token, secret, password, or bearer variants | Dropped. |
| Mixed interpolation such as `prefix-${VAR}` | Dropped. Use a complete `${VAR}` value. |

Use a literal endpoint and environment-backed credentials:

```json
{
  "remote-tools": {
    "type": "http",
    "url": "https://<mcp-host>/mcp",
    "headers": {
      "Authorization": "Bearer ${MCP_BEARER_TOKEN}",
      "X-Tenant": "${MCP_TENANT_ID}",
      "X-Client": "pilotswarm"
    },
    "tools": ["query", "list"]
  }
}
```

Do not write `"url": "https://${MCP_HOST}/mcp"` for Codex. PilotSwarm drops
that server rather than resolving and persisting the URL.

### Local And Stdio

| PilotSwarm `.mcp.json` input | Codex-native result |
|---|---|
| `command`, benign `args`, and `cwd` | Preserved. |
| Any arg containing `${VAR}` | The entire server is dropped because Codex has no safe arg indirection. |
| Sensitive arg flags or values, including auth, token, secret, password, bearer, and key variants | The entire server is dropped rather than persisting the value. |
| `env.KEY: "${KEY}"` | `env_vars: ["KEY"]`; only the variable name is persisted. |
| `env.KEY: "${OTHER_KEY}"` or mixed interpolation | Dropped. |
| Static non-sensitive environment value | Kept in `env`. |
| Static sensitive environment key/value | Dropped. Use same-key `${KEY}` passthrough. |

```json
{
  "local-tools": {
    "type": "stdio",
    "command": "/path/to/mcp-server",
    "args": ["--stdio"],
    "env": {
      "MCP_ACCESS_TOKEN": "${MCP_ACCESS_TOKEN}",
      "LOG_LEVEL": "info"
    },
    "tools": ["*"]
  }
}
```

`tools: ["query", "list"]` becomes Codex `enabled_tools`. `tools: ["*"]` or
an omitted `tools` field omits `enabled_tools`, allowing the server to expose
its normal tool set. PilotSwarm also omits the plugin `type` field because
Codex CLI 0.145.0 infers transport from `url` or `command` and rejects
`mcp_servers.<name>.type`.

Copilot-backed sessions continue to use the Copilot SDK MCP path. See the
[Plugin Architecture Guide](./plugin-architecture-guide.md) for the shared
plugin format.

## Durability And Recovery

Client-created PilotSwarm sessions are durable by default. There is no current
`blobEnabled` client switch. The worker's session store determines where the
runtime snapshot lives:

- the built-in filesystem store enables restart recovery on the same host
- Azure Blob Storage or another shared `SessionStateStore` enables hydration
  on another worker or host

PilotSwarm-owned Codex state is stored under the normal per-session directory:

```text
<session-state>/<session-id>/
|-- codex-thread.json
`-- codex-rollout.jsonl
```

- `codex-thread.json` maps the PilotSwarm session to a Codex thread
- `codex-rollout.jsonl` is a best-effort copy of the Codex rollout
- checkpoint/dehydrate archives those files through the configured session
  store
- hydrate restores them and `thread/resume` receives the restored rollout path

The rollout copy is best-effort. A filesystem race or missing rollout does not
block the checkpoint. Same-host Codex state may still be discoverable inside
`CODEX_HOME`, but cross-worker recovery depends on the shared snapshot.

Authentication is never part of PilotSwarm durability. Every worker that may
resume a Codex session must already have its own valid, private
`CODEX_HOME`. `auth.json` is never persisted by PilotSwarm.

## Dedicated Worker And Client-Only Portal With systemd

Use separate non-root service accounts. The Codex worker account alone owns
and can read `CODEX_HOME`; the network-facing portal account must not be able
to read `auth.json`. Share the checkout, plugin directories, and provider
catalog read-only through a common group or ACL instead of sharing a Unix
identity.

Example worker environment file:

```bash
# /etc/<service-name>/codex-worker.env
DATABASE_URL=postgresql://<db-user>:<db-password>@<db-host>:5432/<db-name>
CODEX_HOME=/home/<worker-user>/.codex
CODEX_BINARY_PATH=/path/to/codex
PS_MODEL_PROVIDERS_PATH=/etc/<service-name>/model_providers.json
SESSION_STATE_DIR=/var/lib/<service-name>/session-state
PLUGIN_DIRS=<pilotswarm-dir>/packages/cli/plugins,<app-plugin-dir>
# Configure a shared store for cross-host recovery when required:
# AZURE_STORAGE_CONNECTION_STRING=<from-secret-environment>
# AZURE_STORAGE_CONTAINER=<session-container>
```

Example dedicated worker unit:

```ini
# /etc/systemd/system/<service-name>-codex-worker.service
[Unit]
Description=PilotSwarm dedicated Codex worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<worker-user>
Group=<shared-read-group>
WorkingDirectory=<pilotswarm-dir>
EnvironmentFile=/etc/<service-name>/codex-worker.env
ExecStart=/usr/bin/node packages/sdk/examples/worker.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Example portal environment file:

```bash
# /etc/<service-name>/portal.env
DATABASE_URL=postgresql://<db-user>:<db-password>@<db-host>:5432/<db-name>
WORKERS=0
PS_MODEL_PROVIDERS_PATH=/etc/<service-name>/model_providers.json
PLUGIN_DIRS=<pilotswarm-dir>/packages/cli/plugins,<app-plugin-dir>
PORTAL_PORT=<portal-port>
```

Example client-only portal unit:

```ini
# /etc/systemd/system/<service-name>-portal.service
[Unit]
Description=PilotSwarm client-only portal
After=network-online.target <service-name>-codex-worker.service
Wants=network-online.target

[Service]
Type=simple
User=<portal-user>
Group=<shared-read-group>
WorkingDirectory=<pilotswarm-dir>
EnvironmentFile=/etc/<service-name>/portal.env
Environment=WORKERS=0
ExecStart=/usr/bin/node packages/portal/bin/serve.js --workers 0 --port <portal-port>
ProtectHome=true
InaccessiblePaths=/home/<worker-user>/.codex
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Before starting the worker:

```bash
sudo -u <worker-user> env \
  CODEX_HOME=/home/<worker-user>/.codex \
  CODEX_BINARY_PATH=/path/to/codex \
  /path/to/codex login status

sudo systemctl daemon-reload
sudo systemctl enable --now <service-name>-codex-worker.service
sudo systemctl enable --now <service-name>-portal.service
```

Verify the portal reports zero embedded workers and that worker logs list the
qualified Codex models. Do not print service environments or `auth.json`.

## Validation

| Layer | What it proves | Command |
|---|---|---|
| Focused automated suite | Provider routing, stdio protocol, tool contract, persistence, durability, native MCP translation/wiring, and reasoning-effort serialization/widening. The gated live file is skipped by default. | `cd packages/sdk && npm run test:local:codex` |
| Live adapter smoke | Direct `CodexRuntimeClient` interoperability with a real `codex app-server`, including one response and one dynamic tool. It bypasses PostgreSQL, duroxide, CMS, and `SessionProxy`. | `cd packages/sdk && RUN_CODEX_LIVE=1 npx vitest run test/local/codex-live.test.js` |
| Full PilotSwarm E2E | Public client -> duroxide orchestration -> activity -> `SessionManager` -> Codex -> dynamic worker tool -> CMS/events. | Use the runbook below. |

### Full PilotSwarm Orchestration E2E

This test uses a fixed, non-secret marker. It is intentionally different from
the live adapter smoke because it exercises the complete PilotSwarm path.

```bash
npm run build --workspace=pilotswarm-sdk
set -a
. ./.env
set +a
export PS_MODEL_PROVIDERS_PATH="$PWD/.model_providers.json"
export CODEX_E2E_MODEL=codex-subscription:gpt-5.6-sol

node --input-type=module <<'NODE'
import {
  PilotSwarmClient,
  PilotSwarmWorker,
  defineTool,
} from "./packages/sdk/dist/index.js";

const marker = "PILOTSWARM_CODEX_E2E_OK";
let calls = 0;
const events = [];

const markerTool = defineTool("codex_e2e_marker", {
  description: "Return the fixed PilotSwarm Codex E2E marker.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async () => {
    calls += 1;
    return marker;
  },
});

const worker = new PilotSwarmWorker({
  store: process.env.DATABASE_URL,
  modelProvidersPath: process.env.PS_MODEL_PROVIDERS_PATH,
  sessionStateDir: process.env.SESSION_STATE_DIR,
  disableManagementAgents: true,
});
worker.registerTools([markerTool]);

const client = new PilotSwarmClient({
  store: process.env.DATABASE_URL,
});

let session;
try {
  await worker.start();
  await client.start();
  session = await client.createSession({
    model: process.env.CODEX_E2E_MODEL,
    reasoningEffort: "low",
    toolNames: ["codex_e2e_marker"],
  });
  session.on((event) => events.push(event.eventType));

  const response = await session.sendAndWait(
    "Call codex_e2e_marker, then reply with exactly its returned text.",
    180_000,
  );

  if (calls < 1) throw new Error("Codex did not call codex_e2e_marker");
  if (response.trim() !== marker) {
    throw new Error(`Expected exact marker ${marker}, got ${response}`);
  }
  if (!events.includes("tool.execution_start")) {
    throw new Error("PilotSwarm did not surface the tool event");
  }
  console.log(`PASS ${marker}`);
} finally {
  if (session) await session.destroy();
  await client.stop();
  await worker.stop();
}
NODE
```

The marker is test data, not a credential. Never substitute an API key, token,
session cookie, or copied authentication value as a validation sentinel.

## Troubleshooting

### Model Or Reasoning Effort Is Missing

- compare the provider catalog with app-server `model/list`
- keep only efforts supported by that exact model and account
- restart the worker and portal after catalog changes
- confirm both processes use the same `PS_MODEL_PROVIDERS_PATH`
- confirm the selected id is provider-qualified

### Native MCP Server Or Tool Is Missing

- make the HTTP URL literal; `${VAR}` in the URL drops the whole server
- use the supported environment-backed header/env forms above
- inspect worker warnings for a dropped server, header, or env entry
- confirm `PLUGIN_DIRS` points at the plugin containing `.mcp.json`
- create a new session after changing native MCP configuration

### Custom PilotSwarm Tool Is Missing

- register the handler on every eligible worker
- check for the nonfatal unresolved-`toolNames` warning
- do not assume a portal embedded worker inherits a headless worker registry
- set portal/TUI `WORKERS=0` when the headless worker owns the tools
- create a new session after adding or renaming a tool schema

### Portal Is Claiming Activities

The portal has embedded workers when `WORKERS` or `--workers` is greater than
zero. Those workers can claim activities before the dedicated worker and may
lack its tools or Codex topology. Set both the environment and launch flag to
zero, restart the portal, and verify the bootstrap worker count is zero.

### Authentication Fails

Run `codex login status` as the worker service user with the exact
`CODEX_HOME`. Logging in as another shell user or as `root` does not
authenticate the service.

### `CODEX_HOME` Permission Error

Ensure the directory exists, is owned by the service user, and has no group or
other permissions:

```bash
chmod 700 /home/<service-user>/.codex
```

### Session Does Not Resume

- same-host recovery needs the filesystem session directory
- cross-worker recovery needs Blob Storage or another shared session store
- verify `codex-thread.json` was restored
- remember that `codex-rollout.jsonl` copy is best-effort
- authenticate the destination worker independently; auth is never hydrated
- keep the Codex provider and model in the catalog for the existing session

### Codex CLI Or Protocol Version Mismatch

Symptoms include initialization failures, rejected `mcp_servers` fields,
missing models/efforts, or resume failures. Reproduce with the focused suite
and live adapter smoke. Roll back or upgrade PilotSwarm, the Codex CLI, and the
provider catalog together rather than changing one component in isolation.

## Rollback

A Codex rollback affects existing sessions, not only new sessions. Removing the
provider or deploying a pre-Codex worker means existing Codex sessions cannot
continue until a compatible provider/runtime is restored.

1. Change the default model and user-facing choices first so no new Codex
   sessions are created.
2. Drain active Codex turns before stopping workers. Do not terminate an
   app-server during a turn unless interruption is intentional.
3. Preserve PostgreSQL, the session store, the per-session Codex files, and the
   service user's `CODEX_HOME`.
4. Roll back PilotSwarm, Codex CLI, and the provider catalog as a tested unit.
   To keep existing sessions runnable, the target unit must still support their
   Codex provider and model.
5. Start the dedicated worker before the client-only portal/TUI.
6. Verify model discovery, run the live adapter smoke, then resume an existing
   noncritical Codex session and confirm its next turn succeeds.

Do not delete state as part of rollback. If a pre-Codex release is required,
expect Codex sessions to remain paused until a compatible Codex-enabled unit is
restored.
