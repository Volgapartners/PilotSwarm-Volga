# Codex Runtime

PilotSwarm can run a session through a local `codex app-server` process instead
of the GitHub Copilot SDK. The public PilotSwarm API stays the same: clients
create sessions, send prompts, subscribe to events, and use durable tools
without knowing which runtime executes the LLM turn.

## What Works

Codex-backed sessions use the same PilotSwarm surfaces as Copilot-backed
sessions:

- `PilotSwarmClient.createSession()` and named-agent creation
- streaming assistant, reasoning, tool, error, and idle events
- worker-registered tools, including `wait`, `cron`, `ask_user`, and sub-agents
- checkpoints, dehydration, hydration, and worker restart recovery
- session management and the existing TUI/portal model selector

No orchestration version change is required. Runtime-specific protocol and
persistence handling stay inside worker activities.

## Requirements

- Node.js 24 or later
- Codex CLI installed on every worker that may run a Codex session
- Codex CLI authenticated as the same operating-system user that runs the worker
- a private `CODEX_HOME` directory with mode `0700`
- a `type: "codex"` entry in the worker's model-provider catalog

Codex CLI 0.145.0 is the version currently verified by the PilotSwarm test
suite. Newer versions may change the app-server protocol or model catalog and
should be validated before rollout.

## Install And Authenticate

Install Codex on the worker:

```bash
npm install -g @openai/codex@0.145.0
codex --version
```

For a local workstation, run:

```bash
codex login
```

For a headless VM, use device authentication:

```bash
codex login --device-auth
```

Open the displayed URL on your workstation and enter the displayed code. Then
verify the worker account:

```bash
chmod 700 ~/.codex
codex login status
```

Run these commands as the same user configured for the PilotSwarm worker
service. Do not copy `auth.json` between machines or users. PilotSwarm never
reads, logs, copies, uploads, or snapshots that file; only the Codex child
process accesses it.

## Configure The Provider

Add a provider to `.model_providers.json`, or to the external catalog selected
by `PS_MODEL_PROVIDERS_PATH`:

```json
{
  "id": "codex-subscription",
  "type": "codex",
  "codexHome": "env:CODEX_HOME",
  "codexBinaryPath": "env:CODEX_BINARY_PATH",
  "models": [
    {
      "name": "gpt-5.6-sol",
      "description": "Codex subscription default",
      "cost": "medium"
    },
    {
      "name": "gpt-5.5",
      "description": "Codex subscription GPT-5.5",
      "cost": "medium"
    }
  ]
}
```

Set the referenced worker environment variables:

```bash
CODEX_HOME=/home/<service-user>/.codex
CODEX_BINARY_PATH=/usr/bin/codex
```

Literal absolute paths may also be placed in the provider catalog. The
provider catalog contains no Codex credential; authentication remains inside
`CODEX_HOME`.

Restart the worker after changing the model-provider catalog.

For systemd, put the variables in the worker service environment or use
literal absolute paths in the external provider catalog. Verify authentication
as the service account, not as `root`:

```bash
sudo -u <service-user> env \
  CODEX_HOME=/home/<service-user>/.codex \
  codex login status
```

## Select A Codex Model

Models use qualified IDs:

```text
codex-subscription:gpt-5.6-sol
codex-subscription:gpt-5.5
```

The provider prefix selects the Codex runtime. The suffix selects the Codex
model. Configured Codex models appear in the existing TUI and portal model
selector alongside Copilot and BYOK models.

From the SDK:

```ts
const session = await client.createSession({
  model: "codex-subscription:gpt-5.6-sol",
  toolNames: ["get_weather"],
});
```

Model availability is account- and Codex-version-dependent. The app-server
`model/list` response is authoritative. Remove models from the provider
catalog if the authenticated account cannot use them.

## Tools

PilotSwarm declares the complete initial tool set to Codex through
`thread/start.dynamicTools`. Tool handlers still run inside the PilotSwarm
worker, so durable tools and application tools retain their existing
semantics.

Codex fixes the visible dynamic-tool schemas when a thread starts. Updating a
worker tool definition refreshes the JavaScript handler for later turns, but
does not add a new schema to an existing Codex thread. Create a new session
after adding or renaming tools.

Codex has no native equivalent of PilotSwarm's `requiredTool` enforcement.
PilotSwarm forwards that value as metadata, but the model may still choose not
to call the requested tool.

## Persistence And Recovery

PilotSwarm stores only non-secret Codex state under the normal session
directory:

```text
<session-state>/<session-id>/
├── codex-thread.json
└── codex-rollout.jsonl
```

- `codex-thread.json` maps the PilotSwarm session to the Codex thread.
- `codex-rollout.jsonl` is copied from the Codex rollout directory before a
  checkpoint or disconnect.
- the normal filesystem or Azure Blob session store archives these files.
- hydration restores the rollout and resumes the same thread with
  `thread/resume`.

`CODEX_HOME/auth.json` is outside this snapshot and is explicitly excluded
from PilotSwarm persistence.

## Concurrency And Multi-User Limits

The initial implementation is for a trusted single operator:

- one `codex app-server` process is maintained per `CODEX_HOME`
- turns sharing that home are serialized
- ChatGPT Plus/Pro authentication must not be shared between PilotSwarm users

For multi-user hosting, use per-user Business/Enterprise access tokens or API
keys when Codex supports the required isolation. Do not point unrelated users
at one Plus/Pro `CODEX_HOME`.

## VM And systemd Checklist

For a VM worker:

1. Install the verified Codex CLI version.
2. Authenticate as the worker service user with `codex login --device-auth`.
3. Set `CODEX_HOME` permissions to `0700`.
4. Add the Codex provider to the catalog used by `PS_MODEL_PROVIDERS_PATH`.
5. Build PilotSwarm and restart the worker service.
6. Confirm the qualified Codex models appear in the model selector.
7. Create a short session and verify a normal response and one tool call.

Authentication can be completed after installing PilotSwarm, but Codex turns
will fail until `codex login status` reports an authenticated account.

After rollout, check the service without printing its environment:

```bash
sudo systemctl restart <worker-service>
sudo systemctl status <worker-service> --no-pager
sudo journalctl -u <worker-service> -n 100 --no-pager
```

Then verify the management model list or UI selector contains the configured
qualified IDs and run a real Codex-backed session.

## Rollback

To stop new Codex sessions without affecting Copilot or BYOK sessions:

1. Remove or disable the `type: "codex"` provider in the model catalog.
2. Change any default model that points at that provider.
3. Restart the worker and portal processes that cache the catalog.

Existing Codex session snapshots can remain in the session store; they contain
thread and rollout state, not credentials. Restore the provider and the same
authenticated service-user `CODEX_HOME` to resume them later.

## Troubleshooting

### `CODEX_HOME ... has insecure permissions`

```bash
chmod 700 "$CODEX_HOME"
```

Ensure the directory is owned by the worker service user.

### `Not logged in`

Run `codex login --device-auth` as the worker service user. Authenticating a
different shell user does not authenticate the worker.

### Model is visible but a turn fails

The provider catalog controls visibility; the authenticated Codex account
controls actual availability. Verify the model against the installed Codex
version and account.

### New tool is not visible

Codex tool schemas are thread-scoped. Start a new PilotSwarm session after
adding or renaming a worker tool.

### Worker restart cannot resume

Confirm the session store contains both the thread marker and, after a turn,
the rollout snapshot. Also confirm the new worker has its own authenticated
private `CODEX_HOME`; credentials are intentionally not restored from session
snapshots.

## Validation

Run the focused suite:

```bash
cd packages/sdk
npm run test:local:codex
```

Run the opt-in live checks only on an authenticated development worker:

```bash
RUN_CODEX_LIVE=1 npx vitest run test/local/codex-live.test.js
```

The live suite consumes subscription turns and verifies both a normal response
and a registered dynamic-tool invocation.
