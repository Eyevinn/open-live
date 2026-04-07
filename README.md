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
# Edit .env with your CouchDB credentials and config
```

## Environment variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port the server listens on | `3000` |
| `COUCHDB_URL` | Full CouchDB connection URL including credentials | `http://admin:password@localhost:5984` |
| `COUCHDB_NAME` | CouchDB database name | `open-live` |
| `CORS_ORIGIN` | Allowed CORS origin(s), comma-separated | `http://localhost:5173` |
| `LOG_LEVEL` | Fastify log level (`trace`, `debug`, `info`, `warn`, `error`) | `info` |

> **Never commit `.env`** — it is gitignored. Use `.env.example` as the reference.

## Commands

```bash
# Start development server with hot reload
pnpm dev

# Type-check without emitting
pnpm typecheck

# Compile TypeScript to dist/
pnpm build

# Start compiled server (production)
pnpm start
```

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/ready` | Readiness check (requires CouchDB) |
| `GET/POST` | `/api/v1/productions` | List / create productions |
| `GET/PATCH/DELETE` | `/api/v1/productions/:id` | Get / update / delete a production |
| `POST` | `/api/v1/productions/:id/activate` | Activate a production |
| `POST` | `/api/v1/productions/:id/deactivate` | Deactivate a production |
| `GET/POST` | `/api/v1/sources` | List / create sources |
| `GET/PATCH/DELETE` | `/api/v1/sources/:id` | Get / update / delete a source |
| `WS` | `/ws/productions/:id/controller` | WebSocket controller channel |
