[![Try on OSC](https://img.shields.io/badge/Try%20on-Open%20Source%20Cloud-blue)](https://openlive.apps.osaas.io)

# open-live

Open Live is a cloud-native live broadcast production suite that replaces traditional hardware — vision mixers, audio consoles, and multiviewers — with a fully browser-based solution. This repository is the central API server. The browser-based production controller lives in [open-live-studio](https://github.com/Eyevinn/open-live-studio).

## Try it on OSC

The fastest way to try Open Live — no Kubernetes required.

Visit **[openlive.apps.osaas.io](https://openlive.apps.osaas.io)** to spin up a managed Open Live instance on Open Source Cloud. Start for an event, tear down after. No infrastructure to manage and no monthly minimum.

- 14-day free trial, free plan available
- 15 EUR/month (self-hosted Strom) or 69 EUR/month (shared GPU in Frankfurt)

The in-app **Create New Open Live** flow provisions CouchDB for you and generates its admin
password automatically. You do not choose or handle that password yourself on this path.
The `COUCHDB_URL` environment variable documented under [Environment variables](#environment-variables)
below is only for a self-hosted deployment where you run CouchDB yourself; it does not apply
to the managed OSC flow above.

**Before you start, two things that are not obvious from the pricing line above:**

- **Shared Strom (the 69 EUR/month option) requires the Professional plan or above.** If your
  account is not eligible, the app shows this up front when you open the environment, not as a
  failed submission after you try to create one.
- **Your own ("BYO") Strom instance has no plan requirement, but its URL must be publicly
  reachable.** A plain local-network or loopback address is rejected, and so is any address
  that is not reachable from OSC, including a plain Tailscale or other mesh-VPN address in the
  `100.64.0.0/10` range even though it clears the initial check. To expose a locally hosted
  Strom instance without port-forwarding, use a public ingress feature such as
  [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) (opt-in, off by default; also
  implemented by self-hosted [Headscale](https://github.com/juanfont/headscale)), which gives
  the instance a genuinely public `ts.net` hostname. On the free plan this path is metered by
  your one-time token allowance rather than gated by plan, so budget for that if you are
  testing rather than running on a paid plan.

## Features

- **Vision mixing** — cuts, auto transitions, DSK layers, picture-in-picture, graphics overlays, and fade-to-black
- **Audio mixer** — per-channel faders with EBU R128 loudness metering
- **Multiviewer** — sub-500ms WebRTC glass-to-glass latency
- **Stream Deck control** — hardware button panel integration
- **Up to 16 sources** per production
- **REMI / remote production** — crews work from anywhere via browser; eliminates travel and equipment shipping
- **Self-hostable** on any Kubernetes cluster, zero vendor lock-in

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
| `API_KEY` | Static API key protecting all `/api/v1` routes, the WebSocket controller, and the Swagger UI. **Required for any network-accessible deployment** (see below) | _(empty — routes unauthenticated)_ |
| `LOG_LEVEL` | Fastify log level (`trace`, `debug`, `info`, `warn`, `error`) | `info` |
| `SOURCE_PROVIDERS` | Comma-separated ids of [source providers](#source-providers) to poll. Unknown ids fail startup. | _(empty — disabled)_ |
| `SOURCE_PROVIDER_POLL_MS` | Interval between source provider polls, in milliseconds | `5000` |

> **Never commit `.env`** — it is gitignored. Use `.env.example` as the reference.

### API authentication

All `/api/v1` routes, the WebSocket controller (`/ws/`), and the Swagger UI
(`/documentation`) are protected by a static API key when `API_KEY` is set. Clients
must send it as a bearer token:

```
Authorization: Bearer <API_KEY>
```

WebSocket clients pass the key via the `?key=<API_KEY>` query parameter on the upgrade
request, since the browser WebSocket API does not support custom headers.

> **`API_KEY` must be set for any network-accessible deployment.** When `API_KEY` is
> unset, every API route is unauthenticated — any client that can reach the service can
> create, modify, delete, and activate productions. The server **refuses to start** when
> `NODE_ENV=production` and `API_KEY` is unset, and logs a prominent warning otherwise.
> Leave it unset **only** when running behind a trusted external auth layer (e.g. the OSC
> reverse proxy). The reference `docker-compose.yml` requires `API_KEY` to be set in your
> `.env` before the stack will start — generate a strong random value with
> `openssl rand -base64 32`.

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
| `POST` | `/api/v1/productions/:id/activate` | Activate production — creates + starts Strom flow |
| `POST` | `/api/v1/productions/:id/deactivate` | Deactivate production — stops + deletes Strom flow |
| `POST` | `/api/v1/productions/:id/sources` | Assign a source to a mixer input |
| `DELETE` | `/api/v1/productions/:id/sources/:mixerInput` | Remove a source assignment |
| `GET/POST` | `/api/v1/sources` | List / create sources |
| `GET/PATCH/DELETE` | `/api/v1/sources/:id` | Get / update / delete a source |
| `GET/POST` | `/api/v1/templates` | List / create Strom flow templates |
| `GET/PATCH/DELETE` | `/api/v1/templates/:id` | Get / update / delete a template |
| `WS` | `/ws/productions/:id/controller` | WebSocket controller channel |

The REST API is documented in `docs/openapi.yaml` (also served at `/documentation`). The
WebSocket controller channel — its authentication, inbound message types, and outbound
broadcasts — is documented separately in [`docs/controller-websocket.md`](docs/controller-websocket.md).

### Source model

Sources represent individual video/audio feeds. Each source has a `streamType` (`srt` or `whip`) and an `address` (SRT URI or WHIP endpoint URL).

SRT passphrases are embedded in the source `address` and encrypted at rest before being stored in CouchDB. For rotating a passphrase or responding to a suspected compromise, see the operator runbook in [`docs/srt-passphrase-rotation.md`](docs/srt-passphrase-rotation.md).

### Source providers

A source provider is a small module under `src/providers/` that lists source candidates produced by another system. The server polls every provider named in `SOURCE_PROVIDERS` and materialises the candidates as ordinary sources, so assignment, activation and the studio UI need no knowledge of where a source came from.

Provider-owned sources carry a `provider` object (`{ id, externalId, syncedAt }`) and `readOnly: true` in API responses. `PATCH` and `DELETE` on them return `409`. A source that the provider stops listing is marked `inactive` rather than deleted, so a production that still references it keeps its assignment.

### Template model

A template is a reusable Strom flow blueprint. It contains:
- `flow` — the full Strom flow JSON (`elements[]`, `blocks[]`, `links[]`)
- `inputs[]` — parametric input slots: `{ id, blockId, addressProperty }` — maps a logical input name to a block in the flow and the property that receives the source address

### Activation flow

1. A production is given a `templateId` and source assignments (`POST /api/v1/productions/:id/sources`)
2. `POST /api/v1/productions/:id/activate` clones the template flow, patches each assigned source's address into the matching block, creates the flow in Strom, and starts it. The `stromFlowId` is stored on the production.
3. `POST /api/v1/productions/:id/deactivate` stops and deletes the Strom flow and clears `stromFlowId`.

## OSC deployment

The app is deployed on [Open Source Cloud](https://www.osaas.io). Environment variables are injected at runtime via an OSC parameter store — no `.env` file is needed on the server.

Required services: CouchDB (`apache-couchdb`), Strom (`eyevinn-strom`), parameter store (`eyevinn-app-config-svc` + `valkey`).
