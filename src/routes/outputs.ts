import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getOutputsDb, getDb } from '../db/index.js';
import type { OutputDoc, ProductionDoc, OutputStatus, RtmpDestination } from '../db/types.js';
import { updateProductionDoc } from './productions.js';
import { deriveOutputStatus } from '../lib/production-health.js';
import { srtUrl } from '../lib/url-validation.js';
import { encryptAddressPassphrase, decryptAddressPassphrase } from '../lib/srt-passphrase-crypto.js';
import { encryptStreamKey } from '../lib/rtmp-credentials-crypto.js';
import { resolveIngestUrl, validateStreamKey } from '../lib/rtmp.js';
import { resolveSrtConnect } from '../lib/srt-connect.js';
import { config } from '../config.js';
import { getPortReservation } from '../services/port-reservation.js';
import { clashesAfterWrite, listenerPortRequest, resolveListenerAddress, usedListenerPorts } from '../services/listener-ports.js';

const SRT_OUTPUT_TYPES = new Set(['mpegtssrt', 'efpsrt']);

/**
 * Set of output IDs that are currently live: assigned to a production that is
 * `active` with a running Strom flow. Used to derive `Output.status` (issue
 * #255). Returns `null` when the production DB is unreachable, so callers can
 * surface `unknown` rather than incorrectly reporting `down`.
 */
async function liveOutputIds(
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<Set<string> | null> {
  try {
    // findTrusted: literal selector written here, no request data (#257)
    const result = await getDb().findTrusted({
      selector: { type: 'production', status: 'active' },
      fields: ['stromFlowId', 'outputAssignments'],
      limit: 200,
    });
    const live = new Set<string>();
    for (const p of result.docs as unknown as ProductionDoc[]) {
      if (!p.stromFlowId) continue; // active but no live flow → not healthy
      for (const a of p.outputAssignments ?? []) live.add(a.outputId);
    }
    return live;
  } catch (err) {
    log.warn({ err }, 'outputs — could not query productions for health derivation');
    return null;
  }
}

/**
 * Derive an output's health from the live-output set (issue #255). `null` means
 * the production DB was unreachable → `unknown`; otherwise membership decides
 * `healthy` vs `down`. The signal is flow-level, so all outputs of a running,
 * playing production read `healthy` uniformly.
 */
function outputStatusFor(outputId: string, live: Set<string> | null): OutputStatus {
  if (live === null) return deriveOutputStatus({ stromKnown: false, productionActive: false, flowRunning: false });
  const isLive = live.has(outputId);
  return deriveOutputStatus({ stromKnown: true, productionActive: isLive, flowRunning: isLive });
}

/**
 * True if `outputId` is assigned to any active/activating production. Used to
 * block a destructive mutation (delete, or an RTMP key/platform change) while a
 * production is live — the composed rtmp_url is baked into the running flow at
 * activation time and there is no live-inject primitive, so a change would not
 * take effect until restart and must not silently diverge from what is on air
 * (spec §Error codes 409, ADR-004 security condition 10).
 */
async function outputInActiveProduction(outputId: string): Promise<boolean> {
  const allProds = await getDb().find({
    selector: { type: 'production' },
    fields: ['_id', 'status', 'outputAssignments'],
    limit: 200,
  });
  return allProds.docs.some((p) => {
    const prod = p as unknown as ProductionDoc;
    return (prod.status === 'active' || prod.status === 'activating') &&
      prod.outputAssignments?.some((a) => a.outputId === outputId);
  });
}

// RTMP destination fields on create/patch. `streamKey` is write-only (accepted
// here, never returned); `ingestUrl` is only honoured for the 'custom' platform
// — named presets resolve their ingest URL server-side from the static table.
const RtmpInput = z.object({
  platform: z.enum(['youtube', 'twitch', 'facebook', 'custom']),
  streamKey: z.string().optional(),
  ingestUrl: z.string().optional(),
});

const OutputInput = z.object({
  name: z.string().min(1).max(256),
  outputType: z.enum(['mpegtssrt', 'efpsrt', 'whep', 'recording', 'rtmp']),
  url: z.string().optional(),
  rtmp: RtmpInput.optional(),
}).superRefine((data, ctx) => {
  const isRtmp = data.outputType === 'rtmp';
  // `rtmp` must be present on an rtmp output and absent on every other type.
  if (isRtmp && !data.rtmp) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rtmp'], message: 'rtmp is required for an rtmp output' });
  }
  if (!isRtmp && data.rtmp) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rtmp'], message: 'rtmp is only valid on an rtmp output' });
  }
  // `url` is an SRT-only field — reject it on an rtmp output so the key can
  // never be smeared into a URL / the derived connect address.
  if (isRtmp && data.url !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is not valid on an rtmp output' });
  }
  if (SRT_OUTPUT_TYPES.has(data.outputType) && data.url) {
    try {
      srtUrl(data.url);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: err instanceof Error ? err.message : 'Invalid SRT URL' });
    }
  }
  if (isRtmp && data.rtmp) {
    // streamKey is required on create (non-empty, no control chars, no encv1:).
    try {
      validateStreamKey(data.rtmp.streamKey ?? '');
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rtmp', 'streamKey'], message: err instanceof Error ? err.message : 'Invalid streamKey' });
    }
    // Resolve/validate the ingest URL (named preset → static table; custom →
    // rtmp(s)-only, SSRF-checked operator URL).
    try {
      resolveIngestUrl(data.rtmp.platform, data.rtmp.ingestUrl);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rtmp', 'ingestUrl'], message: err instanceof Error ? err.message : 'Invalid ingestUrl' });
    }
  }
});

const OutputPatch = z.object({
  name: z.string().min(1).max(256).optional(),
  url: z.string().optional(),
  rtmp: z.object({
    platform: z.enum(['youtube', 'twitch', 'facebook', 'custom']).optional(),
    streamKey: z.string().optional(),
    ingestUrl: z.string().optional(),
  }).optional(),
});

/** Masks passphrase values in SRT URIs so credentials are never returned to clients. */
function maskSrtPassphrase(url: string): string {
  return url.replace(/([?&]passphrase=)[^&]*/gi, '$1***');
}

function toApi(doc: OutputDoc, status?: OutputStatus) {
  // Destructure `rtmp` out of the spread so the stored object (which holds
  // `streamKeyEnc`) is NEVER echoed. We re-add an explicit, key-free projection
  // below — the API only ever exposes platform, ingestUrl, and a streamKeySet
  // boolean (ADR-004 security condition 1).
  const { _id, _rev, type, status: _persistedStatus, rtmp, ...rest } = doc;
  const api: Record<string, unknown> = { id: _id, ...rest };
  if (rtmp) {
    api['rtmp'] = {
      platform: rtmp.platform,
      ingestUrl: rtmp.ingestUrl,
      streamKeySet: !!rtmp.streamKeyEnc,
    };
  }
  // Passphrases are stored encrypted (encv1:...); decrypt before masking so the
  // mask matches on the "passphrase=" param regardless of storage form. Legacy
  // plaintext passphrases pass through decryption unchanged (issue #260).
  if (doc.url) {
    api['url'] = maskSrtPassphrase(decryptAddressPassphrase(doc.url));
  }
  // Surface a read-only, derived dial-in address for SRT outputs so operators
  // can see the connectable host, not just the bind port (issue #176). Omitted
  // for whep outputs and for SRT outputs with no bind URL (those are inert).
  // Derive from the decrypted URL — resolveSrtConnect only reads host/port/mode,
  // which are cleartext, and its output never carries the passphrase param.
  if (SRT_OUTPUT_TYPES.has(doc.outputType) && doc.url) {
    const connect = resolveSrtConnect(decryptAddressPassphrase(doc.url), {
      stromUrl: config.stromUrl,
      srtPublicHost: config.srtPublicHost,
    });
    if (connect) api['connect'] = connect;
  }
  // Derived output health (issue #255). Computed on read from the owning
  // production's live flow state, not persisted, so it is always current.
  if (status !== undefined) api['status'] = status;
  return api;
}

const outputsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/outputs', async (_req, reply) => {
    const db = getOutputsDb();
    let result: Awaited<ReturnType<typeof db.find>>;
    try {
      result = await db.find({ selector: { type: 'output' } });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/outputs — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable' });
    }
    const live = await liveOutputIds(fastify.log);
    return reply.send(
      (Array.isArray(result?.docs) ? result.docs : []).map((doc) =>
        toApi(doc, outputStatusFor(doc._id, live)),
      ),
    );
  });

  fastify.post('/api/v1/outputs', async (req, reply) => {
    const body = OutputInput.parse(req.body);
    const id = `output-${randomUUID()}`;
    // RTMP is an outbound connect to the platform — it leases NO SRT listener
    // port (unlike the SRT-listener path below), so skip that branch entirely.
    // The ingest URL is resolved server-side (named preset → static table; a
    // 'custom' URL was scheme/SSRF-validated in the schema) and the stream key
    // is encrypted at rest under RTMP_CREDENTIALS_KEY. `url` is never populated.
    if (body.outputType === 'rtmp') {
      const rtmpBody = body.rtmp!; // superRefine guarantees presence + valid key
      const ingestUrl = resolveIngestUrl(rtmpBody.platform, rtmpBody.ingestUrl);
      const now = new Date().toISOString();
      const doc: OutputDoc = {
        _id: id,
        type: 'output',
        name: body.name,
        outputType: 'rtmp',
        rtmp: {
          platform: rtmpBody.platform,
          ingestUrl,
          // Encrypt the raw key before it touches CouchDB. Validation already
          // rejected an `encv1:` prefix, so this always produces ciphertext
          // (given a configured key) — a key beginning with `encv1:` can never
          // be stored plaintext (ADR-004 security condition 4).
          streamKeyEnc: encryptStreamKey(rtmpBody.streamKey!),
        },
        createdAt: now,
        updatedAt: now,
      };
      await getOutputsDb().insert(doc);
      return reply.status(201).send(toApi(doc));
    }
    const isSrt = SRT_OUTPUT_TYPES.has(body.outputType) && !!body.url;
    // A listener output binds a port on the shared Strom, like a listener source
    // does: same range, same uniqueness, same port-0 assignment, same re-check.
    let used = isSrt ? await usedListenerPorts() : [];
    for (let attempt = 0; ; attempt++) {
      let url = body.url;
      let port: number | null = null;
      if (isSrt && url) {
        const resolved = resolveListenerAddress(url, getPortReservation(), used);
        if (!resolved.ok) {
          return reply.status(resolved.statusCode).send({ error: resolved.error, statusCode: resolved.statusCode });
        }
        ({ address: url, port } = resolved);
      }
      const now = new Date().toISOString();
      const doc: OutputDoc = {
        _id: id,
        type: 'output',
        name: body.name,
        outputType: body.outputType,
        // Encrypt any embedded SRT passphrase before it touches CouchDB (issue #260).
        url: url !== undefined ? encryptAddressPassphrase(url) : url,
        createdAt: now,
        updatedAt: now,
      };
      const written = await getOutputsDb().insert(doc);
      if (port === null) return reply.status(201).send(toApi(doc));
      used = await usedListenerPorts();
      const clash = clashesAfterWrite(used, { kind: 'output', id }, port);
      if (!clash) return reply.status(201).send(toApi(doc));
      await getOutputsDb().destroy(id, written.rev);
      if (listenerPortRequest(body.url ?? '') !== 0 || attempt >= 3) {
        return reply.status(409).send({ error: `SRT listener port ${port} is already used by ${clash.kind} "${clash.name}"`, statusCode: 409 });
      }
      fastify.log.warn({ port, clash }, 'listener port was taken while assigning it, choosing another');
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/outputs/:id', async (req, reply) => {
    try {
      const doc = await getOutputsDb().get(req.params.id);
      const live = await liveOutputIds(fastify.log);
      return reply.send(toApi(doc, outputStatusFor(doc._id, live)));
    } catch {
      return reply.status(404).send({ error: 'Output not found', statusCode: 404 });
    }
  });

  fastify.patch<{ Params: { id: string } }>('/api/v1/outputs/:id', async (req, reply) => {
    const body = OutputPatch.parse(req.body);
    try {
      const doc = await getOutputsDb().get(req.params.id);

      // Separate the rtmp patch from the generic field spread so a plaintext
      // streamKey is NEVER written straight onto the persisted doc.
      const { rtmp: rtmpPatch, ...scalarPatch } = body;

      // Field/type coherence: rtmp fields only on an rtmp output; url only off it.
      if (rtmpPatch && doc.outputType !== 'rtmp') {
        return reply.status(400).send({ error: 'rtmp is only valid on an rtmp output', statusCode: 400 });
      }
      if (doc.outputType === 'rtmp' && body.url !== undefined) {
        return reply.status(400).send({ error: 'url is not valid on an rtmp output', statusCode: 400 });
      }

      // ---- RTMP patch: re-resolve ingestUrl, re-encrypt/clear/keep key ----
      let rtmpDoc: RtmpDestination | undefined = doc.rtmp;
      if (doc.outputType === 'rtmp' && rtmpPatch) {
        const mutatesCredential =
          rtmpPatch.platform !== undefined || rtmpPatch.streamKey !== undefined || rtmpPatch.ingestUrl !== undefined;
        // Block key/platform mutation while the destination is live (409) — the
        // composed rtmp_url is baked into the running flow at activation time and
        // there is no live-inject primitive (ADR-004 security condition 10).
        if (mutatesCredential && (await outputInActiveProduction(doc._id))) {
          return reply.status(409).send({ error: 'Output is used in an active production', statusCode: 409 });
        }
        const current = doc.rtmp ?? { platform: 'custom' as const, ingestUrl: '' };
        const platform = rtmpPatch.platform ?? current.platform;
        // Re-resolve the ingest URL (named preset → static table; custom → the
        // new or existing operator URL). 400 on unknown platform / bad custom URL.
        let ingestUrl: string;
        try {
          const customUrl = rtmpPatch.ingestUrl ?? (current.platform === 'custom' ? current.ingestUrl : undefined);
          ingestUrl = resolveIngestUrl(platform, customUrl);
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid rtmp destination', statusCode: 400 });
        }
        // streamKey: omitted → keep stored ciphertext; "" → clear; else validate
        // + re-encrypt (mirrors the SRT "leave URL as-is when patch omits it").
        let streamKeyEnc = current.streamKeyEnc;
        if (rtmpPatch.streamKey !== undefined) {
          if (rtmpPatch.streamKey === '') {
            streamKeyEnc = undefined;
          } else {
            try {
              validateStreamKey(rtmpPatch.streamKey);
            } catch (err) {
              return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid streamKey', statusCode: 400 });
            }
            streamKeyEnc = encryptStreamKey(rtmpPatch.streamKey);
          }
        }
        rtmpDoc = { platform, ingestUrl, ...(streamKeyEnc !== undefined ? { streamKeyEnc } : {}) };
      }

      // Validate the effective URL if output type is SRT-based. Validate against
      // the plaintext form — a new body.url is already plaintext, while the
      // stored doc.url may hold an encrypted passphrase.
      const effectiveUrl = body.url ?? (doc.url ? decryptAddressPassphrase(doc.url) : doc.url);
      if (SRT_OUTPUT_TYPES.has(doc.outputType) && effectiveUrl) {
        try {
          srtUrl(effectiveUrl);
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid SRT URL' });
        }
        // Re-check the port only when the URL changes — a rename must not fail
        // because an older output predates the lease. Port 0 keeps the current one.
        if (body.url !== undefined) {
          const resolved = resolveListenerAddress(effectiveUrl, getPortReservation(), await usedListenerPorts(), {
            exclude: { kind: 'output', id: doc._id },
            keep: doc.url ? listenerPortRequest(doc.url) : null,
          });
          if (!resolved.ok) {
            return reply.status(resolved.statusCode).send({ error: resolved.error, statusCode: resolved.statusCode });
          }
          body.url = resolved.address;
        }
      }
      // Encrypt the passphrase in an updated URL before persisting. When the
      // patch leaves the URL untouched, keep the already-stored value as-is.
      const urlPatch = body.url !== undefined
        ? { url: encryptAddressPassphrase(body.url) }
        : {};
      // Spread only the scalar patch (name/url) — never the raw rtmp patch, which
      // would smear a plaintext streamKey onto the doc. The rtmp object is
      // rebuilt above (ciphertext only) and replaces the stored one wholesale so
      // a cleared key does not linger.
      const rtmpUpdate = doc.outputType === 'rtmp' ? { rtmp: rtmpDoc } : {};
      const updated: OutputDoc = { ...doc, ...scalarPatch, ...urlPatch, ...rtmpUpdate, updatedAt: new Date().toISOString() };
      await getOutputsDb().insert(updated);
      return reply.send(toApi(updated));
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Output not found', statusCode: 404 });
      }
      throw err;
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/v1/outputs/:id', async (req, reply) => {
    try {
      const doc = await getOutputsDb().get(req.params.id);

      // Block deletion if output is used by an active/activating production
      const allProds = await getDb().find({
        selector: { type: 'production' },
        fields: ['_id', 'name', 'status', 'outputAssignments', 'deletionWarnings'],
        limit: 200,
      });
      const activeInUse = allProds.docs.some((p) => {
        const prod = p as unknown as ProductionDoc;
        return (prod.status === 'active' || prod.status === 'activating') &&
          prod.outputAssignments?.some((a) => a.outputId === req.params.id);
      });
      if (activeInUse) {
        return reply.status(409).send({ error: 'Output is used in an active production', statusCode: 409 });
      }

      // Remove references from inactive productions and record a warning
      for (const p of allProds.docs) {
        const prod = p as unknown as ProductionDoc;
        if (prod.status !== 'inactive') continue;
        if (!prod.outputAssignments?.some((a) => a.outputId === req.params.id)) continue;
        const warnings = prod.deletionWarnings ?? [];
        warnings.push({ type: 'output', name: doc.name });
        await updateProductionDoc(prod._id, {
          outputAssignments: (prod.outputAssignments ?? []).filter((a) => a.outputId !== req.params.id),
          deletionWarnings: warnings,
        });
      }

      await getOutputsDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Output not found' });
      }
      throw err;
    }
  });
};

export default outputsRoutes;
