# pilotswarm-sdk

Durable runtime primitives for building apps on top of PilotSwarm.

Install:

```bash
npm install pilotswarm-sdk
```

Minimal usage:

```ts
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";
```

`pilotswarm-sdk` ships PilotSwarm's embedded framework prompt, framework skills, and management plugins inside the package. App code should provide its own `plugin/` directory and worker-side tool handlers on top of that base.

Workers need one configured LLM path: a GitHub token, BYOK provider
credentials, or a worker-side authenticated Codex CLI subscription. Codex
subscription mode uses `CODEX_HOME` login state and does not require an API
key. Clients do not need LLM credentials.

Common docs:

- SDK apps: `https://github.com/affandar/PilotSwarm/blob/main/docs/sdk/building-apps.md`
- SDK agents: `https://github.com/affandar/PilotSwarm/blob/main/docs/sdk/building-agents.md`
- Configuration: `https://github.com/affandar/PilotSwarm/blob/main/docs/configuration.md`
- Codex runtime: `https://github.com/affandar/PilotSwarm/blob/main/docs/codex-runtime.md`
- Architecture: `https://github.com/affandar/PilotSwarm/blob/main/docs/architecture.md`

If you want the shipped terminal UI, install `pilotswarm-cli`.
