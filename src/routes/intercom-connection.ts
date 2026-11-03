/**
 * Intercom-connection REST surface (issue #617, OL-47,
 * `docs/specs/intercom-connection.md`, ADR-013).
 *
 *   GET    /api/v1/intercom-connection        status of the connection in effect
 *   PUT    /api/v1/intercom-connection        set / replace the stored connection
 *   DELETE /api/v1/intercom-connection        clear it (env vars, if any, apply again)
 *   POST   /api/v1/intercom-connection/test   probe unsaved values, or the one in effect
 *
 * All routes sit behind the shared `API_KEY` bearer `onRequest` gate
 * (`src/server.ts`), identical to `/api/v1/storage-connections`. DB failures
 * return 503.
 *
 * Secrets (`apiKey`, `whipKey`) are write-only: encrypted immediately
 * (`encv1:`, shared credential-encryption key family, ADR-009 D1), NEVER
 * returned (the view exposes only `tokenSet` / `whipKeySet`) and NEVER logged
 * — no handler here logs a request body. The manager URL is SSRF-gated by
 * `TRUSTED_INTERCOM_HOSTS`.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getIntercomConnectionDb } from '../db/index.js';
import type { IntercomConnectionDoc } from '../db/types.js';
import { config } from '../config.js';
import {
  INTERCOM_CONNECTION_DOC_ID,
  IntercomConnectionInputError,
  assertIntercomHostAllowed,
  decryptIntercomSecret,
  encryptIntercomSecret,
  inferIntercomAuthMode,
  intercomConnectionStatus,
  isOscHost,
  normalizeIntercomManagerUrl,
  readStoredIntercomConnection,
  resolveEnvIntercomConnection,
  resolveStoredIntercomConnection,
  type IntercomAuthMode,
  type ResolvedIntercomConnection,
} from '../lib/intercom-connection.js';
import { testIntercomConnection } from '../lib/intercom-manager.js';

const modeEnum = z.enum(['osc', 'direct']);

const PutInput = z.object({
  url: z.string().min(1).max(2048),
  /** Advanced override; inferred from the host when omitted. */
  mode: modeEnum.optional(),
  /** Manager API key (direct mode). Omitted = keep the stored one, if the manager origin is unchanged. */
  apiKey: z.string().min(1).max(4096).optional(),
  /** Manager WHIP/WHEP key (direct mode, optional). Omitted = keep (same origin); null = clear. */
  whipKey: z.string().min(1).max(4096).nullable().optional(),
});

const TestInput = z.object({
  url: z.string().min(1).max(2048).optional(),
  mode: modeEnum.optional(),
  apiKey: z.string().min(1).max(4096).optional(),
  whipKey: z.string().min(1).max(4096).optional(),
});

function badRequest(reply: FastifyReply, error: string) {
  return reply.status(400).send({ error, statusCode: 400 });
}

function dbUnavailable(reply: FastifyReply) {
  return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
}

/**
 * Validate an operator-supplied URL + mode (shared by PUT and unsaved test):
 * normalise, SSRF-gate, infer or check the mode. `osc` is only allowed for an
 * OSC host — it sends a SAT minted from the instance's own OSC PAT, which must
 * never go to a non-OSC host.
 *
 * @throws {IntercomConnectionInputError}
 */
function validateTarget(rawUrl: string, mode: IntercomAuthMode | undefined) {
  const n = normalizeIntercomManagerUrl(rawUrl);
  assertIntercomHostAllowed(n.hostname, config.trustedIntercomHosts);
  const effective = mode ?? inferIntercomAuthMode(n.hostname);
  if (effective === 'osc') {
    if (!isOscHost(n.hostname)) {
      throw new IntercomConnectionInputError(
        'osc mode is only allowed for an OSC-hosted manager (*.osaas.io): it sends a token minted from this instance’s OSC access token',
      );
    }
    if (!n.url.startsWith('https://')) {
      throw new IntercomConnectionInputError('osc mode requires an https manager URL');
    }
  }
  return { ...n, mode: effective, modeOverridden: mode !== undefined };
}

/** A stored secret is only carried over when the manager origin is unchanged — never sent to a new host. */
function keepSecret(existing: IntercomConnectionDoc | undefined, origin: string, field: 'tokenEnc' | 'whipKeyEnc') {
  if (!existing?.[field] || existing.mode !== 'direct') return undefined;
  try {
    return new URL(existing.url).origin === origin ? existing[field] : undefined;
  } catch {
    return undefined;
  }
}

const intercomConnectionRoutes: FastifyPluginAsync = async (fastify) => {
  // Status of the connection in effect (stored, else env, else none).
  fastify.get('/api/v1/intercom-connection', async (_req, reply) => {
    let doc: IntercomConnectionDoc | undefined;
    try {
      doc = await readStoredIntercomConnection();
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/intercom-connection — DB read failed');
      return dbUnavailable(reply);
    }
    const conn = doc ? resolveStoredIntercomConnection(doc) : resolveEnvIntercomConnection();
    return reply.send(intercomConnectionStatus(conn));
  });

  // Set / replace the stored connection.
  fastify.put('/api/v1/intercom-connection', async (req, reply) => {
    const body = PutInput.parse(req.body);
    let target: ReturnType<typeof validateTarget>;
    try {
      target = validateTarget(body.url, body.mode);
    } catch (err) {
      if (err instanceof IntercomConnectionInputError) return badRequest(reply, err.message);
      throw err;
    }
    if (target.mode === 'osc' && (body.apiKey !== undefined || (body.whipKey !== undefined && body.whipKey !== null))) {
      return badRequest(
        reply,
        'osc mode uses this instance’s OSC access token; do not send apiKey or whipKey (use mode "direct" for an API-key manager)',
      );
    }

    let existing: IntercomConnectionDoc | undefined;
    try {
      existing = await readStoredIntercomConnection();
    } catch (err) {
      fastify.log.warn({ err }, 'PUT /api/v1/intercom-connection — DB read failed');
      return dbUnavailable(reply);
    }

    let tokenEnc: string | undefined;
    let whipKeyEnc: string | undefined;
    if (target.mode === 'direct') {
      tokenEnc = body.apiKey !== undefined ? encryptIntercomSecret(body.apiKey) : keepSecret(existing, target.origin, 'tokenEnc');
      if (!tokenEnc) {
        return badRequest(reply, 'apiKey is required for a direct-mode manager (a stored key is only kept when the manager URL’s origin is unchanged)');
      }
      whipKeyEnc =
        body.whipKey === null
          ? undefined
          : body.whipKey !== undefined
            ? encryptIntercomSecret(body.whipKey)
            : keepSecret(existing, target.origin, 'whipKeyEnc');
    }

    const now = new Date().toISOString();
    const doc: IntercomConnectionDoc = {
      _id: INTERCOM_CONNECTION_DOC_ID,
      ...(existing?._rev ? { _rev: existing._rev } : {}),
      type: 'intercom-connection',
      url: target.url,
      mode: target.mode,
      modeOverridden: target.modeOverridden,
      ...(tokenEnc ? { tokenEnc } : {}),
      ...(whipKeyEnc ? { whipKeyEnc } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      await getIntercomConnectionDb().insert(doc);
    } catch (err) {
      if ((err as { statusCode?: number } | null)?.statusCode === 409) {
        return reply.status(409).send({ error: 'The intercom connection was changed concurrently; retry', statusCode: 409 });
      }
      fastify.log.warn({ err }, 'PUT /api/v1/intercom-connection — DB write failed');
      return dbUnavailable(reply);
    }
    fastify.log.info(
      { source: 'stored', mode: doc.mode, modeOverridden: doc.modeOverridden },
      'intercom connection set',
    );
    return reply.send(intercomConnectionStatus(resolveStoredIntercomConnection(doc)));
  });

  // Clear the stored connection. Idempotent; env vars (if any) apply again.
  fastify.delete('/api/v1/intercom-connection', async (_req, reply) => {
    let existing: IntercomConnectionDoc | undefined;
    try {
      existing = await readStoredIntercomConnection();
      if (existing?._rev) await getIntercomConnectionDb().destroy(existing._id, existing._rev);
    } catch (err) {
      if ((err as { statusCode?: number } | null)?.statusCode === 404) return reply.status(204).send();
      fastify.log.warn({ err }, 'DELETE /api/v1/intercom-connection — DB write failed');
      return dbUnavailable(reply);
    }
    if (existing) fastify.log.info({ source: 'stored' }, 'intercom connection cleared');
    return reply.status(204).send();
  });

  // Test unsaved form values ({ url, apiKey?, whipKey?, mode? }), or with an
  // empty body the connection in effect. Structured result at HTTP 200.
  fastify.post('/api/v1/intercom-connection/test', async (req, reply) => {
    const body = TestInput.parse(req.body ?? {});

    let existing: IntercomConnectionDoc | undefined;
    try {
      existing = await readStoredIntercomConnection();
    } catch (err) {
      fastify.log.warn({ err }, 'POST /api/v1/intercom-connection/test — DB read failed');
      return dbUnavailable(reply);
    }

    let conn: ResolvedIntercomConnection | undefined;
    let source: 'unsaved' | 'stored' | 'env';
    if (body.url === undefined) {
      if (body.apiKey !== undefined || body.whipKey !== undefined || body.mode !== undefined) {
        return badRequest(reply, 'url is required when testing unsaved values');
      }
      conn = existing ? resolveStoredIntercomConnection(existing) : resolveEnvIntercomConnection();
      if (!conn) {
        return reply.send({
          ok: false,
          status: 'not-configured',
          message: 'No intercom connection is configured',
          source: 'none',
        });
      }
      source = conn.source;
    } else {
      let target: ReturnType<typeof validateTarget>;
      try {
        target = validateTarget(body.url, body.mode);
      } catch (err) {
        if (err instanceof IntercomConnectionInputError) return badRequest(reply, err.message);
        throw err;
      }
      if (target.mode === 'osc' && (body.apiKey !== undefined || body.whipKey !== undefined)) {
        return badRequest(reply, 'osc mode uses this instance’s OSC access token; do not send apiKey or whipKey');
      }
      source = 'unsaved';
      let credential: string | undefined;
      let whipKey: string | undefined;
      let problem: string | undefined;
      if (target.mode === 'osc') {
        credential = config.oscPat;
        if (!credential) {
          problem = 'osc mode needs the instance OSC access token (OscAccessToken / OSC_PAT), which is not set on this instance';
        }
      } else {
        // Unsaved values win; a stored secret is reused only for the same manager origin.
        try {
          const keptToken = keepSecret(existing, target.origin, 'tokenEnc');
          const keptWhip = keepSecret(existing, target.origin, 'whipKeyEnc');
          credential = body.apiKey ?? (keptToken ? decryptIntercomSecret(keptToken) : undefined);
          whipKey = body.whipKey ?? (keptWhip ? decryptIntercomSecret(keptWhip) : undefined);
        } catch {
          problem = 'The stored key could not be decrypted; enter it again';
        }
        if (!credential && !problem) problem = 'apiKey is required to test a direct-mode manager';
      }
      conn = {
        source: 'stored',
        url: target.url,
        origin: target.origin,
        mode: target.mode,
        modeOverridden: target.modeOverridden,
        ...(target.mode === 'osc' ? { patSource: 'OscAccessToken' as const } : {}),
        ...(credential && !problem ? { credential } : {}),
        ...(whipKey ? { whipKey } : {}),
        ...(problem ? { problem } : {}),
        tokenSet: !!credential,
        whipKeySet: !!whipKey,
      };
    }

    const result = await testIntercomConnection(conn);
    return reply.send({ ...result, source });
  });
};

export default intercomConnectionRoutes;
