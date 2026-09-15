import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { z } from 'zod';
import { getGatewaysDb } from '../db/index.js';
import type { GatewayDoc, GatewayInputStatus } from '../db/types.js';
import { verifyGatewayToken } from '../lib/gateway-token.js';
import { config } from '../config.js';
import { CONTRACT_VERSION } from '../services/automation-contract.js';

/**
 * OL-5 Studio Gateways Phase 1 — inbound heartbeat WebSocket (issue #263,
 * `docs/specs/studio-gateways.md` §6).
 *
 * The *gateway* (open-live-ingest box) dials this socket to push status to Open
 * Live. Phase 1 is gateway → Open Live ONLY: the server replies with envelope /
 * ack frames (`HELLO`, `SNAPSHOT_END`, `ACK`, `ERROR`) — never control commands.
 * Any downstream `START`/`STOP` frame is Phase 2 and out of scope here.
 *
 * Auth (ADR-001): the gateway presents its per-gateway bearer token, NOT the
 * shared `API_KEY`. The token is verified against the stored hash for the path
 * `:id`. The upgrade is completed even on failure so we can send a structured
 * `ERROR { code: "unauthorized" }` and close with application code 4401.
 */

// WS application close code for an unauthorized heartbeat connection (spec §6).
const WS_CLOSE_UNAUTHORIZED = 4401;

// Sentinel subprotocol carrying the per-gateway token on a browser-style WS
// upgrade, mirroring the existing `openlive.bearer.<key>` split (server.ts).
// Non-browser ingest boxes should prefer the Authorization header.
const WS_GATEWAY_SUBPROTOCOL_PREFIX = 'openlive.gateway.';

/** Extract the per-gateway token from an Authorization bearer header, if present. */
function tokenFromAuthHeader(authorization: string | undefined): string | undefined {
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
}

/** Extract the per-gateway token from the `openlive.gateway.<token>` subprotocol, if present. */
function tokenFromSubprotocol(header: string | string[] | undefined): string | undefined {
  if (!header) return undefined;
  const values = Array.isArray(header) ? header : header.split(',');
  for (const raw of values) {
    const proto = raw.trim();
    if (proto.startsWith(WS_GATEWAY_SUBPROTOCOL_PREFIX)) {
      return proto.slice(WS_GATEWAY_SUBPROTOCOL_PREFIX.length);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-gateway monotonic outbound seq (mirrors #209's per-production seq). In
// memory only; resets on server restart (documented behaviour inherited from
// the automation contract).
// ---------------------------------------------------------------------------
const seqByGateway = new Map<string, number>();
function nextSeq(gatewayId: string): number {
  const next = (seqByGateway.get(gatewayId) ?? -1) + 1;
  seqByGateway.set(gatewayId, next);
  return next;
}

function send(socket: WebSocket, gatewayId: string, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify({ ...frame, seq: nextSeq(gatewayId), ts: new Date().toISOString() }));
}

// ---------------------------------------------------------------------------
// Inbound status-frame validation. Forward-compat rule (inherited from #209):
// unknown frame types and unknown fields are ignored. `.passthrough()` keeps
// unknown fields; `.catchall` on the union is handled by the dispatch below.
// ---------------------------------------------------------------------------
const UplinkSchema = z.object({
  bitrateKbps: z.number(),
  rtt_ms: z.number(),
  dropped: z.number(),
}).passthrough();

const InputSchema = z.object({
  inputId: z.string(),
  name: z.string(),
  flowState: z.enum(['idle', 'playing', 'paused']),
  sourceId: z.string().nullable().default(null),
  uplink: UplinkSchema.nullable().default(null),
}).passthrough();

const OnlineOrHeartbeatSchema = z.object({
  host: z.string().optional(),
  stromVersion: z.string().optional(),
  deviceCount: z.number().optional(),
  streamingCount: z.number().optional(),
  inputs: z.array(InputSchema).optional(),
}).passthrough();

/** The snapshot fields a HEARTBEAT/GATEWAY_ONLINE frame can update on the doc. */
interface Snapshot {
  host?: string;
  stromVersion?: string;
  deviceCount?: number;
  streamingCount?: number;
  inputs?: GatewayInputStatus[];
}

const MAX_DB_WRITE_RETRIES = 3;

function isConflictError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'statusCode' in err &&
    (err as { statusCode?: number }).statusCode === 409
  );
}

/**
 * Persist a heartbeat: update `lastSeenAt` plus any changed snapshot fields via
 * a conflict-retry write (mirrors the controller's persistMixerMutation
 * re-read-on-409 pattern). Debounced by the caller.
 */
async function persistHeartbeat(gatewayId: string, snapshot: Snapshot): Promise<void> {
  const db = getGatewaysDb();
  for (let attempt = 0; attempt < MAX_DB_WRITE_RETRIES; attempt++) {
    try {
      const current = await db.get(gatewayId);
      const updated: GatewayDoc = {
        ...current,
        ...snapshot,
        lastSeenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await db.insert(updated);
      return;
    } catch (err) {
      if (isConflictError(err) && attempt < MAX_DB_WRITE_RETRIES - 1) continue;
      // Give up quietly: a dropped heartbeat write is non-fatal — the next
      // heartbeat re-establishes lastSeenAt and health is derived on read.
      console.warn('[gateway-heartbeat] failed to persist heartbeat', { gatewayId }, err);
      return;
    }
  }
}

const gatewayHeartbeatWs: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    '/ws/gateways/:id/heartbeat',
    { websocket: true },
    async (socket, req) => {
      const { id } = req.params;

      // ---- Auth handshake (ADR-001): per-gateway token vs stored hash ----
      const token =
        tokenFromAuthHeader(req.headers['authorization']) ??
        tokenFromSubprotocol(req.headers['sec-websocket-protocol']);

      let doc: GatewayDoc | null = null;
      if (token) {
        try {
          doc = await getGatewaysDb().get(id);
        } catch {
          doc = null;
        }
      }

      if (!token || !doc || !verifyGatewayToken(token, doc.tokenHash)) {
        // Upgrade already completed: send a structured error, then close 4401.
        send(socket, id, { type: 'ERROR', code: 'unauthorized' });
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }

      // ---- Connect sequence (mirrors #209 HELLO … SNAPSHOT_END) ----
      send(socket, id, {
        type: 'HELLO',
        contractVersion: CONTRACT_VERSION,
        gatewayId: id,
        heartbeatIntervalSeconds: config.gatewayHeartbeatIntervalSeconds,
      });
      // Nothing to replay to the gateway in Phase 1 (outbound-only from gateway).
      send(socket, id, { type: 'SNAPSHOT_END' });

      // Debounce: cap CouchDB writes to one per persist-min-interval.
      let lastPersistAt = 0;

      socket.on('message', (raw: Buffer | string) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          send(socket, id, { type: 'ERROR', code: 'invalid_frame' });
          return;
        }
        if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
          send(socket, id, { type: 'ERROR', code: 'invalid_frame' });
          return;
        }
        const type = (msg as { type: string }).type;
        const ackSeq = (msg as { seq?: unknown }).seq;

        switch (type) {
          case 'GATEWAY_ONLINE':
          case 'HEARTBEAT': {
            const parsed = OnlineOrHeartbeatSchema.safeParse(msg);
            if (!parsed.success) {
              send(socket, id, { type: 'ERROR', code: 'invalid_frame' });
              return;
            }
            const snapshot: Snapshot = {};
            if (parsed.data.host !== undefined) snapshot.host = parsed.data.host;
            if (parsed.data.stromVersion !== undefined) snapshot.stromVersion = parsed.data.stromVersion;
            if (parsed.data.deviceCount !== undefined) snapshot.deviceCount = parsed.data.deviceCount;
            if (parsed.data.streamingCount !== undefined) snapshot.streamingCount = parsed.data.streamingCount;
            if (parsed.data.inputs !== undefined) {
              snapshot.inputs = parsed.data.inputs.map((i) => ({
                inputId: i.inputId,
                name: i.name,
                flowState: i.flowState,
                sourceId: i.sourceId,
                uplink: i.uplink
                  ? { bitrateKbps: i.uplink.bitrateKbps, rtt_ms: i.uplink.rtt_ms, dropped: i.uplink.dropped }
                  : null,
              }));
            }
            const now = Date.now();
            if (now - lastPersistAt >= config.gatewayHeartbeatPersistMinIntervalMs) {
              lastPersistAt = now;
              void persistHeartbeat(id, snapshot);
            }
            if (typeof ackSeq === 'number') {
              send(socket, id, { type: 'ACK', ackSeq });
            }
            return;
          }
          case 'GATEWAY_OFFLINE': {
            // Best-effort graceful-shutdown notice. We do not backdate
            // lastSeenAt; health derives to `down` naturally once the last
            // heartbeat ages past the threshold.
            if (typeof ackSeq === 'number') {
              send(socket, id, { type: 'ACK', ackSeq });
            }
            return;
          }
          default:
            // Forward-compat: silently ignore unknown frame types (#209 rule).
            return;
        }
      });

      socket.on('close', () => {
        // Nothing to tear down: seq state is retained so a reconnecting gateway
        // continues its monotonic outbound sequence within this server lifetime.
      });
    },
  );
};

export default gatewayHeartbeatWs;
