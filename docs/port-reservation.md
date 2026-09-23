# SRT port reservation on a shared Strom

When several Open Live instances share one Strom, every SRT *listener* source
or output (`srt://:PORT?mode=listener`) binds a port on that same Strom. Two
instances picking the same port would collide. To prevent that, each Open Live
instance reserves a set of SRT listener ports from Strom and only accepts
listener sources and outputs on ports it holds.

The requests go to `STROM_URL` under `/api/ports/reservations`, over the same
connection and the same credentials Open Live already uses for flows. Strom
administers the pool its operator configures (`STROM_PORTS`) and hands port
numbers out of it. A Strom with no pool configured hands out nothing, and Open
Live then applies no port restriction.

The ports are an explicit list, **not a range**. Strom prefers a contiguous run
and prefers extending one when an instance grows, but a hole in the pool,
another owner's ports, or one Strom found already bound can put a gap anywhere.

Caller addresses (`srt://host:PORT?mode=caller`), WHIP, WHEP and HTML are not
affected.

## What the server does

- **At startup** it asks Strom for `STROM_PORT_LEASE_SIZE` ports under a stable
  owner id. Strom never moves ports an owner already holds, so the same numbers
  come back on every restart as long as the owner id is unchanged and the
  reservation has not expired.
- **Every minute** it renews. If Strom has forgotten the reservation (for
  example after a restart without persistence) the server takes one again under
  the same owner id and logs a warning naming any port it did not get back.
- **On `SIGTERM` / `SIGINT`** it releases the reservation so the ports are free
  for the next instance.
- **When a production starts** it tells Strom which of its ports that flow uses
  (`POST .../assign`), so they are not reclaimed under a running pipeline if
  this instance dies without releasing. Best effort — the reservation is what
  actually holds the ports.
- **If Strom hands out no ports**, the server logs one warning, stops enforcing
  ports, and re-checks every 10 minutes. Two answers mean this:
  - `409` **and** `GET /api/ports` reporting `enabled: false` — Strom has the
    routes but no pool configured. The fix is `STROM_PORTS` on Strom, no
    upgrade needed. (A `409` with a pool that *is* enabled means the pool is
    full instead, and the server keeps retrying.)
  - `404` — nothing serves the pool routes at `STROM_URL` at all: a Strom older
    than the feature, or a proxy in front of one.

## Ports inside the range

The lease keeps instances apart; inside one instance every listener source and
output must also have its own port, because each binds it on the same Strom.
Open Live assigns those ports:

- A listener address with port `0`, such as `srt://:0?mode=listener`, asks the
  server to choose. The lowest port it holds not held by any other source
  or output is written into the stored address and returned. Gateways register
  this way, so several gateways can feed one instance without coordinating.
- An explicit port must be one this instance reserved and not held by another source or
  output; otherwise the request fails with `422` or `409` naming the holder.
- A `PATCH` with port `0` keeps the port the document already has when it is
  still valid, so re-registering after a restart is stable.
- Without a reservation (`unsupported` or `disabled`) explicit ports still have to be
  unique, and port `0` is refused with `400` since there is nothing to choose from.

## Effect on the API

`GET /api/v1/server-info` reports the range so gateways can pick ports for the
sources they register:

```json
{
  "stromHost": "strom.example.com",
  "srtPorts": [47100, 47101, 47102],
  "srtPortState": "reserved"
}
```

`srtPortState` is one of:

| Value | Meaning | Listener sources and outputs |
|---|---|---|
| `reserved` | Ports held; `srtPorts` lists them | Must use one of them, otherwise `422` |
| `pending` | Not held yet (Strom unreachable or pool full) | Rejected with `503` until they are |
| `unsupported` | Strom hands out no ports: no pool configured, or no pool routes | Accepted, not checked |
| `disabled` | `STROM_PORT_LEASE_DISABLED=true` | Accepted, not checked |

`POST`/`PATCH` on `/api/v1/sources` and `/api/v1/outputs` apply the checks when
the address or URL is a hostless SRT listener. A `422` names the ports this instance holds,
a `409` names the source or output that already holds the port.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `STROM_PORT_LEASE_SIZE` | Number of SRT listener ports to reserve | `10` |
| `STROM_PORT_LEASE_CLIENT_ID` | Owner id sent to Strom. Keep it stable across restarts so the instance gets its ports back | hostname of `PUBLIC_BASE_URL`, else `open-live-<hostname>` |
| `STROM_PORT_LEASE_DISABLED` | `true` turns the feature off entirely (single-tenant Strom) | `false` |

## Operator notes

- The pool lives on Strom, not here. Set `STROM_PORTS=47100-47999` on the shared
  Strom and open those ports inbound on its host. A Strom serving a single Open
  Live needs no pool at all.
- `GET /api/ports` on Strom answers whether it hands out ports and how much of
  its pool is free, whether or not a pool is configured — the quickest way to
  tell "Strom will never hand out ports" from "Strom is briefly unreachable",
  and what the server itself uses to tell the two meanings of `409` apart.
- Size the reservation for the number of listener sources the instance will have
  active at once; the pool on Strom is shared, so do not over-allocate.
- If the server logs that Strom has no free ports left,
  the pool cannot fit the request: lower `STROM_PORT_LEASE_SIZE`, release
  reservations from decommissioned instances, or grow the pool on Strom.
- Sources and outputs created before the lease existed are not re-validated on
  rename. They are checked again the next time their address or URL is edited.
- Size the reservation for sources and outputs together: a production's SRT outputs
  in listener mode take ports from the same block, one port per document.
