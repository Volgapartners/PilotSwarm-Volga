# Downstream Eval Guide

v0 supports a small live eval path that downstream apps can copy and extend
locally. Keep scenarios JSON-only and put executable app logic in plugins.

The v0 managed runner uses PilotSwarm's configured default model but still
requires the existing GitHub token path. Codex is not yet a configurable eval
target; use the [Codex Runtime validation guide](../../../docs/codex-runtime.md#validation)
for focused Codex checks.

## Source Checkout Setup

The v0 eval harness is a private PilotSwarm workspace package. It is not
published to the npm registry. Keep the downstream `eval/` directory in a
PilotSwarm source checkout, or add equivalent workspace wiring in the
downstream monorepo.

From the PilotSwarm repo root:

```bash
npm install
npm run build --workspace=pilotswarm-eval-harness
```

The workspace install makes `pilotswarm-eval-harness` available to plugin
imports inside that checkout.

## Layout

```text
eval/
  eval-plugins.js
  scenarios/incident-triage.scenario.json
  runs/smoke/config.json
  runs/smoke/scenarios.jsonl
```

## Scenario

```json
{
  "schemaVersion": 1,
  "kind": "single-turn",
  "id": "incident.triage.owner",
  "description": "Triage an incident and name the owning service.",
  "tools": ["incident_lookup"],
  "tags": ["smoke"],
  "input": { "prompt": "Look up incident INC-42 and report the owning service." },
  "checks": [
    { "type": "tool-call", "name": "incident_lookup" },
    { "type": "response-contains", "any": ["checkout"] }
  ]
}
```

## Plugin

```js
import { registerTool } from "pilotswarm-eval-harness";

registerTool({
  name: "incident_lookup",
  description: "Look up an incident by id.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" }
    },
    required: ["id"],
    additionalProperties: false
  },
  handler: async (args) => ({ id: args.id, service: "checkout" })
});
```

## Run Config

`eval/runs/smoke/scenarios.jsonl`:

```jsonl
{"schemaVersion":1}
{"include":"../../scenarios/**/*.scenario.json"}
```

`eval/runs/smoke/config.json`:

```json
{
  "schemaVersion": 1,
  "id": "smoke",
  "scenarios": "./scenarios.jsonl",
  "defaults": {
    "driver": "live",
    "isolation": "shared-worker",
    "concurrent": 1,
    "timeoutMs": 900000
  },
  "reporters": ["console"]
}
```

Run it:

```bash
set -a; source .env; set +a
packages/eval-harness/bin/run-eval.sh --config=eval/runs/smoke/config.json --require=eval/eval-plugins.js
```

## Conventions

- Keep scenario files declarative JSON. Put functions, mocks, fixtures, service
  lookups, and app-specific assertions in plugins.
- Prefer one scenario per file. Avoid sample expansion or hidden generated
  cases in v0.
- Keep smoke manifests small and cheap. Put broader coverage in an explicit
  `live-all` or nightly-style run.
- Use stable scenario ids and tags so results can be compared over time.
- Make prompts direct. If a check expects a tool, the prompt should name that
  tool and the arguments clearly.
- Treat `llm-judge` as a focused qualitative check, not a replacement for
  deterministic tool/CMS assertions.
- Add new check types or schema fields only when several scenarios need them
  and the existing JSON shape cannot express the behavior.

## Expanding Complexity Later

The intended growth path is:

1. Add JSON scenarios and manifests.
2. Add plugin tools for app-specific behavior.
3. Add a custom check type only when deterministic built-ins are insufficient.
4. Add new reporters or matrix runners only after the core live path is stable
   and the added output is consumed by a real workflow.

Do not start with model sweeps, prompt variants, ablations, or post-run
trajectory summaries unless the PR is explicitly about that feature.
