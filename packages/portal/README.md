# pilotswarm-web

Web portal for PilotSwarm — React frontend with an Express + WebSocket backend.

The React app lives in `src/` and is the authoritative portal frontend. The
Node server in `server.js` provides the backend API/WebSocket layer and can
optionally embed local workers.

## Quick Start

```bash
# Install workspace dependencies from the repo root
npm install

# Terminal 1: React app (Vite)
npm run dev --workspace=packages/portal

# Terminal 2: portal backend / WebSocket server
node --env-file=.env.remote packages/portal/server.js
```

Development URLs:

- React app: `http://localhost:5173`
- Portal backend: `http://localhost:3001`

## Architecture

```
Browser (React + Vite or built static assets)
  │
  ├── WebSocket ──► Portal Server (Express + ws on /portal-ws)
  │                    │
  │                    ├── PilotSwarmClient
  │                    ├── PilotSwarmManagementClient
  │                    └── PilotSwarmWorker (embedded or remote workers)
  │
  └── REST (/api/health, /api/models)
```

Same public API boundary as the TUI — only `PilotSwarmClient`,
`PilotSwarmManagementClient`, and `PilotSwarmWorker` APIs. No internal
module imports.

## Package Relationship

```
pilotswarm-web         (this package)
  ├── pilotswarm-sdk
  ├── express
  ├── ws
  ├── react, react-dom
  └── vite             (devDependency for the frontend)

pilotswarm-cli         (TUI — separate package)
  └── pilotswarm-sdk

pilotswarm-sdk         (runtime — shared)
  └── duroxide, copilot-sdk, etc.
```

## Scripts

```bash
npm run dev --workspace=packages/portal         # Vite frontend
npm run dev:server --workspace=packages/portal  # backend only
npm run build --workspace=packages/portal       # build frontend to dist/
npm run start --workspace=packages/portal       # serve backend + built dist/ if present
```
