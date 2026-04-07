# open-live

Central API server for the Open Live broadcast production platform. Built with Node.js, TypeScript, and Fastify. Persists data to CouchDB.

## Requirements

- Node.js 23+
- pnpm 10.33+
- CouchDB instance (local or remote)

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env with your credentials and config
```

## Environment variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port the server listens on | `3000` |
| `COUCHDB_URL` | Full CouchDB connection URL including credentials | required |
| `COUCHDB_NAME` | CouchDB database name | `open-live` |
| `CORS_ORIGIN` | Allowed CORS origin (URL of the studio frontend) | `http://localhost:5173` |
| `STROM_URL` | Base URL of the Strom pipeline engine | `http://localhost:7000` |
| `STROM_TOKEN` | OSC Personal Access Token for authenticating against an OSC-hosted Strom instance | _(empty — not needed for local Strom)_ |
| `LOG_LEVEL` | Fastify log level (`trace`, `debug`, `info`, `warn`, `error`) | `info` |

> **Never commit `.env`** — it is gitignored. Use `.env.example` as the reference.

### Strom authentication

When `STROM_URL` points to an OSC-hosted Strom instance, set `STROM_TOKEN` to your OSC Personal Access Token. The server automatically exchanges it for a short-lived Service Access Token (SAT) and refreshes it before expiry. No extra steps needed.

Leave `STROM_TOKEN` unset when running Strom locally without authentication.

## Commands

```bash
# Start development server with hot reload
pnpm dev

# Type-check without emitting
pnpm typecheck

# Compile TypeScript to dist/
pnpm build

# Start compiled server (production / OSC deployment)
pnpm start
```

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/healthz` | Liveness check (OSC health probe alias) |
| `GET` | `/ready` | Readiness check (requires CouchDB) |
| `GET/POST` | `/api/v1/productions` | List / create productions |
| `GET/PATCH/DELETE` | `/api/v1/productions/:id` | Get / update / delete a production |
| `POST` | `/api/v1/productions/:id/activate` | Activate a production (also fetches Strom version) |
| `POST` | `/api/v1/productions/:id/deactivate` | Deactivate a production |
| `GET/POST` | `/api/v1/sources` | List / create sources |
| `GET/PATCH/DELETE` | `/api/v1/sources/:id` | Get / update / delete a source |
| `WS` | `/ws/productions/:id/controller` | WebSocket controller channel |

## OSC deployment

The app is deployed on [Open Source Cloud](https://www.osaas.io). Environment variables are injected at runtime via an OSC parameter store — no `.env` file is needed on the server.

Required services: CouchDB (`apache-couchdb`), Strom (`eyevinn-strom`), parameter store (`eyevinn-app-config-svc` + `valkey`).
