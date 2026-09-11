# SRT port lease on a shared Strom

When several Open Live instances share one Strom, every SRT *listener* source
or output (`srt://:PORT?mode=listener`) binds a port on that same Strom. Two
instances picking the same port would collide. To prevent that, each Open Live
instance leases a contiguous range of SRT listener ports and only accepts
listener sources and outputs inside its range.

The lease requests go to `STROM_URL` under `/api/port-leases`. On a shared
Strom a proxy in front of it routes that path to a port broker service, which
owns the pool; everything else passes through to Strom. A self-hosted Strom
with no proxy answers 404, and Open Live then applies no port restriction.

Caller addresses (`srt://host:PORT?mode=caller`), WHIP, WHEP and HTML are not
affected.

## What the server does

- **At startup** it asks Strom for `STROM_PORT_LEASE_SIZE` consecutive ports
  under a stable client id. Strom hands back the same range on every restart as
  long as the client id is unchanged and the lease has not expired.
- **Every minute** it renews the lease. If Strom has forgotten the lease
  (for example after a restart without persistence) the server re-acquires one
  under the same client id and logs a warning if the range changed.
- **On `SIGTERM` / `SIGINT`** it releases the lease so the ports are free for
  the next instance.
- **If nothing answers the lease routes** (a Strom with no port broker in
  front of it), the server logs one warning, stops enforcing ports, and
  re-checks every 10 minutes.

## Ports inside the range

The lease keeps instances apart; inside one instance every listener source and
output must also have its own port, because each binds it on the same Strom.
Open Live assigns those ports:

- A listener address with port `0`, such as `srt://:0?mode=listener`, asks the
  server to choose. The lowest port in the range not held by any other source
  or output is written into the stored address and returned. Gateways register
  this way, so several gateways can feed one instance without coordinating.
- An explicit port must be inside the range and not held by another source or
  output; otherwise the request fails with `422` or `409` naming the holder.
- A `PATCH` with port `0` keeps the port the document already has when it is
  still valid, so re-registering after a restart is stable.
- Without a range (`unsupported` or `disabled`) explicit ports still have to be
  unique, and port `0` is refused with `400` since there is nothing to choose from.

## Effect on the API

`GET /api/v1/server-info` reports the range so gateways can pick ports for the
sources they register:

```json
{
  "stromHost": "strom.example.com",
  "srtPortRange": { "first": 47100, "last": 47119 },
  "srtPortLease": "leased"
}
```

`srtPortLease` is one of:

| Value | Meaning | Listener sources and outputs |
|---|---|---|
| `leased` | Range acquired; `srtPortRange` is set | Must use a port in the range, otherwise `422` |
| `pending` | Not acquired yet (Strom unreachable or pool full) | Rejected with `503` until the lease is acquired |
| `unsupported` | No port broker answers at `STROM_URL` | Accepted, not checked |
| `disabled` | `STROM_PORT_LEASE_DISABLED=true` | Accepted, not checked |

`POST`/`PATCH` on `/api/v1/sources` and `/api/v1/outputs` apply the checks when
the address or URL is a hostless SRT listener. A `422` names the allowed range,
a `409` names the source or output that already holds the port.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `STROM_PORT_LEASE_SIZE` | Number of consecutive SRT listener ports to lease | `20` |
| `STROM_PORT_LEASE_CLIENT_ID` | Client id sent to Strom. Keep it stable across restarts so the instance gets its range back | hostname of `PUBLIC_BASE_URL`, else `open-live-<hostname>` |
| `STROM_PORT_LEASE_DISABLED` | `true` turns the feature off entirely (single-tenant Strom) | `false` |

## Operator notes

- Size the range for the number of listener sources the instance will have
  active at once; the pool on Strom is shared, so do not over-allocate.
- If the server logs `Failed to acquire SRT port range` with a `409` from Strom,
  the pool cannot fit the request: lower `STROM_PORT_LEASE_SIZE`, release
  leases from decommissioned instances, or grow the pool on the port broker.
- Sources and outputs created before the lease existed are not re-validated on
  rename. They are checked again the next time their address or URL is edited.
- Size the range for sources and outputs together: a production's SRT outputs
  in listener mode take ports from the same block, one port per document.
