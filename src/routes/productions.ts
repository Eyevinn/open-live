import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb, getOutputsDb } from '../db/index.js';
import type { ProductionDoc, ProductionSourceAssignment, ProductionGraphicAssignment, ProductionOutputAssignment, OutputDoc } from '../db/types.js';
import { StromClient, StromClientError } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { activateStromFlow, deactivateStromFlow } from '../lib/flow-generator.js';
import { setTally, broadcast, getSubscriberCount } from '../services/tally.service.js';
import { clearProductionPflState } from '../services/pfl-state.js';
import { clearPipState, clearAudioState, clearFxState } from '../ws/controller.js';
import { config } from '../config.js';
import { getIdleSince, getIdleExpiresAt, notifyProductionActivated, notifyProductionDeactivated } from '../services/idle-watchdog.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLOW_POLL_INTERVAL_MS = 500;
const FLOW_POLL_TIMEOUT_MS = 30_000;
const MAX_DB_WRITE_RETRIES = 3;

// ---------------------------------------------------------------------------
// AbortController map — keyed by production ID, allows deactivate to cancel
// an in-progress activation polling loop.
// ---------------------------------------------------------------------------

const activationAbortControllers = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a partial update to ProductionDoc with retry-on-409.
 * Re-reads the document before each retry to get the latest _rev.
 */
export async function updateProductionDoc(
  productionId: string,
  patch: Partial<ProductionDoc>,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_DB_WRITE_RETRIES; attempt++) {
    try {
      const doc = await getDb().get(productionId);
      const updated: ProductionDoc = {
        ...doc,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await getDb().insert(updated);
      return;
    } catch (err) {
      // CouchDB 409 = revision conflict — retry after re-read
      if (err instanceof Error && 'statusCode' in err && (err as { statusCode?: number }).statusCode === 409) {
        if (attempt < MAX_DB_WRITE_RETRIES - 1) continue;
      }
      throw err;
    }
  }
}

/**
 * Async activation polling loop — runs fire-and-forget after the HTTP
 * response has already been sent.
 *
 * Lifecycle:
 *   1. Call activateStromFlow to create + start the Strom flow.
 *   2. Persist stromFlowId + mixerBlockId (status stays 'activating').
 *   3. Poll strom.flows.get(flowId) every FLOW_POLL_INTERVAL_MS.
 *   4. On flow.state === 'playing': fetch WHEP URL, set status 'active'.
 *   5. On timeout, error, or abort: best-effort cleanup, set status 'inactive'.
 */
async function runActivationFlow(
  productionId: string,
  signal: AbortSignal,
  log: { error: (obj: unknown, msg: string) => void; info: (obj: unknown, msg: string) => void },
  publicBaseUrl: string,
): Promise<void> {
  let stromFlowId: string | undefined;
  let mixerBlockId: string | undefined;
  let audioMixerBlockId: string | undefined;
  let loudnessMainBlockId: string | undefined;
  let whepOutputEntries: Array<{ outputId: string; endpointId: string }> | undefined;
  let pgmWhepEndpointId: string | undefined;

  try {
    // Load the current production doc
    const doc = await getDb().get(productionId);

    // Load assigned output docs; '__whep__' is a virtual output (no DB entry)
    const outputDocs: OutputDoc[] = [];
    for (const a of doc.outputAssignments ?? []) {
      if (a.outputId === '__whep__') {
        outputDocs.push({ _id: '__whep__', type: 'output', outputType: 'whep', name: 'WHEP Output', createdAt: '', updatedAt: '' });
        continue;
      }
      try {
        const od = await getOutputsDb().get(a.outputId) as unknown as OutputDoc;
        outputDocs.push(od);
      } catch {
        // skip outputs that no longer exist
      }
    }

    const stromToken = await getStromToken(config.stromToken);
    const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });

    // Step 1: Start the Strom flow
    if (signal.aborted) return;
    const activation = await activateStromFlow(doc, strom, config.stromUrl, outputDocs.length > 0 ? outputDocs : undefined);
    stromFlowId = activation.flowId;
    mixerBlockId = activation.mixerBlockId ?? undefined;
    audioMixerBlockId = activation.audioMixerBlockId ?? undefined;
    loudnessMainBlockId = activation.loudnessMainBlockId ?? undefined;
    whepOutputEntries = activation.whepOutputEntries;
    pgmWhepEndpointId = activation.pgmWhepEndpointId;
    // mixerBlockId/audioMixerBlockId come directly from the flow generator — they are the
    // randomised IDs actually used in the live Strom flow, not the static template IDs.

    // Step 2: Persist stromFlowId + mixerBlockId + audioMixerBlockId
    if (signal.aborted) {
      await deactivateStromFlow(stromFlowId, strom).catch(() => undefined);
      return;
    }
    await updateProductionDoc(productionId, {
      stromFlowId,
      ...(mixerBlockId !== undefined && { mixerBlockId }),
      ...(audioMixerBlockId !== undefined && { audioMixerBlockId }),
      ...(loudnessMainBlockId !== undefined && { loudnessMainBlockId }),
      ...(Object.keys(activation.sourceOffsetBlockIds).length > 0 && { sourceOffsetBlockIds: activation.sourceOffsetBlockIds }),
      ...(Object.keys(activation.sourceAudioOffsetBlockIds).length > 0 && { sourceAudioOffsetBlockIds: activation.sourceAudioOffsetBlockIds }),
    });

    // Step 3: Poll until flow reaches 'playing' or we time out
    const deadline = Date.now() + FLOW_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (signal.aborted) {
        await deactivateStromFlow(stromFlowId, strom).catch(() => undefined);
        return;
      }

      const { flow } = await strom.flows.get(stromFlowId);

      if (flow.running === true) {
        // Resolve audioMixerBlockId from the running flow — this is the authoritative source.
        // Strom may assign a server-generated ID that differs from the template's block ID,
        // so always prefer the live flow value over the template-derived one.
        const runningAudioBlock = (flow.blocks ?? []).find(
          (b) => (b as unknown as { block_definition_id?: string }).block_definition_id === 'builtin.mixer',
        ) as { id?: string; properties?: Record<string, unknown> } | undefined;
        if (runningAudioBlock?.id) audioMixerBlockId = runningAudioBlock.id;


        // Re-resolve sourceOffsetBlockIds from the running flow — Strom may assign server-generated
        // IDs that differ from the template block IDs we stored at activation time.
        // Strategy: find all builtin.time_offset blocks and match their names to mixerInputs.
        // The flow generator names them "Offset V{padIndex}" where padIndex maps to video_in_{N},
        // so this is reliable without needing flow.links (which may be absent in the GET response).
        const runningOffsetBlocks = (flow.blocks ?? []).filter(
          (b) => b.block_definition_id === 'builtin.time_offset',
        );
        if (runningOffsetBlocks.length > 0) {
          const resolvedOffsetBlockIds: Record<string, string> = {};
          const resolvedAudioOffsetBlockIds: Record<string, string> = {};
          for (const offsetBlock of runningOffsetBlocks) {
            if (!offsetBlock.id) continue;
            // "Offset V{N}" → video_in_{N}
            const videoMatch = /^Offset V(\d+)$/.exec(offsetBlock.name ?? '');
            if (videoMatch) {
              resolvedOffsetBlockIds[`video_in_${videoMatch[1]}`] = offsetBlock.id;
              continue;
            }
            // "Offset A{N}" → video_in_{N} (audio delay, keyed by the same mixerInput)
            const audioMatch = /^Offset A(\d+)$/.exec(offsetBlock.name ?? '');
            if (audioMatch) {
              resolvedAudioOffsetBlockIds[`video_in_${audioMatch[1]}`] = offsetBlock.id;
            }
          }
          if (Object.keys(resolvedOffsetBlockIds).length > 0) {
            activation.sourceOffsetBlockIds = resolvedOffsetBlockIds;
            log.info({ productionId, resolvedOffsetBlockIds }, 'Re-resolved sourceOffsetBlockIds from running flow');
          }
          if (Object.keys(resolvedAudioOffsetBlockIds).length > 0) {
            activation.sourceAudioOffsetBlockIds = resolvedAudioOffsetBlockIds;
            log.info({ productionId, resolvedAudioOffsetBlockIds }, 'Re-resolved sourceAudioOffsetBlockIds from running flow');
          }
        }

        // Step 4: Retrieve WHEP multiview endpoint
        let whepEndpoint: string | undefined;
        if (mixerBlockId) {
          const resp = await strom.mixer.multiviewEndpoint(stromFlowId, mixerBlockId).catch(() => null);
          // Guard: deactivate may have fired while multiviewEndpoint() was in-flight.
          // Without this check, updateProductionDoc would write status:'active' after
          // deactivate has already written status:'inactive'.
          if (signal.aborted) {
            await deactivateStromFlow(stromFlowId, strom).catch(() => {});
            return;
          }
          if (resp?.endpoint) whepEndpoint = `${config.stromUrl}${resp.endpoint}`;
        }

        if (signal.aborted) {
          await deactivateStromFlow(stromFlowId, strom).catch(() => {});
          return;
        }

        // Derive initial tally from first two source assignments so the
        // controller shows selected sources immediately on first connect.
        const reloadedDoc = await getDb().get(productionId);

        // Compute WHIP ingest endpoints for __whip__ source assignments.
        // URLs point to the Open Live WHIP proxy — Strom URL stays internal.
        const whipEndpoints = reloadedDoc.sources
          .filter((s) => s.sourceId === 'Whip')
          .map((s) => ({
            mixerInput: s.mixerInput,
            url: `${publicBaseUrl}/api/v1/productions/${productionId}/whip/${encodeURIComponent(s.mixerInput)}`,
          }));
        const sortedSources = [...reloadedDoc.sources].sort((a, b) =>
          a.mixerInput.localeCompare(b.mixerInput),
        );
        const initialTally = {
          pgm: sortedSources[0]?.mixerInput ?? null,
          pvw: sortedSources[1]?.mixerInput ?? null,
        };
        setTally(productionId, initialTally);

        // NOTE: Do NOT call strom.mixer.transition() here.
        // Strom's trigger_transition API ignores from_input/to_input — it always
        // transitions from the current PGM to the current PVW in its overlay state.
        // Strom initialises with PGM=0 and PVW=1 by default, which already matches
        // our initialTally (pgm=video_in_0, pvw=video_in_1). Calling transition()
        // would fire an unintended TAKE that swaps PGM and PVW, making the
        // multiview show the opposite of what the controller displays.

        // Build WHEP output URLs from endpoint IDs. Strom serves each WHEP
        // output at /whep/{endpoint_id} — construct the URL directly rather
        // than calling listStreams() whose response type lacks a url field.
        const whepOutputUrls: Array<{ outputId: string; url: string }> | undefined =
          whepOutputEntries && whepOutputEntries.length > 0
            ? whepOutputEntries.map(({ outputId, endpointId }) => ({
                outputId,
                url: `${config.stromUrl}/whep/${endpointId}`,
              }))
            : undefined;

        await updateProductionDoc(productionId, {
          status: 'active',
          whepEndpoint,
          pgmWhepEndpoint: pgmWhepEndpointId ? `${config.stromUrl}/whep/${pgmWhepEndpointId}` : undefined,
          whipEndpoints: whipEndpoints.length > 0 ? whipEndpoints : undefined,
          srtOutputUri: undefined,
          whepOutputUrls: whepOutputUrls && whepOutputUrls.length > 0 ? whepOutputUrls : undefined,
          tally: initialTally,
          ...(audioMixerBlockId !== undefined && { audioMixerBlockId }),
          ...(loudnessMainBlockId !== undefined && { loudnessMainBlockId }),
          ...(Object.keys(activation.sourceOffsetBlockIds).length > 0 && { sourceOffsetBlockIds: activation.sourceOffsetBlockIds }),
          ...(Object.keys(activation.sourceAudioOffsetBlockIds).length > 0 && { sourceAudioOffsetBlockIds: activation.sourceAudioOffsetBlockIds }),
        });

        notifyProductionActivated(productionId);
        log.info({ productionId, stromFlowId, whepEndpoint, initialTally, audioMixerBlockId }, 'Production activated — flow playing');
        return;
      }

      // Wait before next poll
      await new Promise<void>((resolve) => setTimeout(resolve, FLOW_POLL_INTERVAL_MS));
    }

    // Timeout reached
    throw new Error(`Strom flow ${stromFlowId} did not reach 'playing' state within ${FLOW_POLL_TIMEOUT_MS}ms`);
  } catch (err) {
    if (signal.aborted) {
      // Deactivate called during activation — cleanup already handled by deactivate handler
      return;
    }

    log.error({ err, productionId, stromFlowId }, 'Activation flow failed — resetting to inactive');

    // Best-effort flow cleanup
    if (stromFlowId) {
      const stromToken = await getStromToken(config.stromToken).catch((err) => { log.error({ errMsg: err instanceof Error ? err.message : String(err) }, "SAT exchange failed — proceeding without auth"); return undefined; });
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      await deactivateStromFlow(stromFlowId, strom).catch(() => undefined);
    }

    // Reset production to inactive, clearing all flow-related fields
    await updateProductionDoc(productionId, {
      status: 'inactive',
      stromFlowId: undefined,
      mixerBlockId: undefined,
      whepEndpoint: undefined,
      pgmWhepEndpoint: undefined,
      whipEndpoints: undefined,
    }).catch((resetErr) => {
      log.error({ resetErr, productionId }, 'Failed to reset production to inactive after activation failure');
    });

    notifyProductionDeactivated(productionId);
  } finally {
    activationAbortControllers.delete(productionId);
  }
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ProductionInput = z.object({
  name: z.string().min(1).max(256),
});

// Format-specific allowlists for production `values` that are forwarded verbatim
// to Strom block properties by flow-generator.ts. Validated here so malformed
// values are rejected with a 400 (via the global ZodError handler) rather than
// being injected into Strom flow properties (issue #88).
//
// - resolution keys (pgm_resolution, multiview_resolution) → e.g. "1280x720"
// - framerate keys  (pgm_framerate, multiview_framerate)   → e.g. "30" or "30000/1001"
//   (fractions must allow NTSC-style rates like 30000/1001, so up to 6 digits/side)
// - clock → forwarded as the flow-level `clock_type` property; fixed set only.
const RESOLUTION_RE = /^\d{3,5}x\d{3,5}$/;
const FRAMERATE_RE = /^\d{1,6}\/\d{1,6}$|^\d{1,3}$/;
const CLOCK_TYPES = new Set(['ntp', 'gst', 'system']);

const RESOLUTION_VALUE_KEYS = ['pgm_resolution', 'multiview_resolution'] as const;
const FRAMERATE_VALUE_KEYS = ['pgm_framerate', 'multiview_framerate'] as const;

const ProductionValues = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .superRefine((values, ctx) => {
    for (const key of RESOLUTION_VALUE_KEYS) {
      const v = values[key];
      if (typeof v === 'string' && !RESOLUTION_RE.test(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must match <width>x<height> (e.g. "1280x720")`,
        });
      }
    }
    for (const key of FRAMERATE_VALUE_KEYS) {
      const v = values[key];
      if (typeof v === 'string' && !FRAMERATE_RE.test(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be an integer or fraction (e.g. "30" or "30000/1001")`,
        });
      }
    }
    const clock = values['clock'];
    if (typeof clock === 'string' && clock !== '' && !CLOCK_TYPES.has(clock)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clock'],
        message: `clock must be one of: ${[...CLOCK_TYPES].join(', ')}`,
      });
    }
  });

const ProductionPatch = z.object({
  name: z.string().min(1).max(256).optional(),
  values: ProductionValues.optional(),
  airTime: z.string().datetime().nullable().optional(),
});

// mixerInput must match the Strom pad naming convention (e.g. "video_in_0", "video_in_15")
const mixerInputSchema = z.string().regex(/^video_in_\d{1,2}$/, 'mixerInput must match video_in_N format').max(20);

const SourceAssignmentInput = z.object({
  sourceId: z.string().min(1).max(128),
  mixerInput: mixerInputSchema,
});

const GraphicAssignmentInput = z.object({
  graphicId: z.string().min(1),
  dskInput: z.string().min(1),
});

const OutputAssignmentInput = z.object({
  outputId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const productionsRoutes: FastifyPluginAsync = async (fastify) => {
  // List all productions
  fastify.get('/api/v1/productions', async (_req, reply) => {
    const db = getDb();
    let result: Awaited<ReturnType<typeof db.find>>;
    try {
      result = await db.find({ selector: { type: 'production' } });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/productions — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable' });
    }
    const docs = (Array.isArray(result?.docs) ? (result.docs as ProductionDoc[]) : []).map((doc) => {
      if (doc.status !== 'active') return doc;
      const subscriberCount = getSubscriberCount(doc._id);
      const idleSinceAt = getIdleSince(doc._id);
      const idleExpiresAt = idleSinceAt !== undefined ? getIdleExpiresAt(idleSinceAt) : undefined;
      return { ...doc, subscriberCount, ...(idleExpiresAt !== undefined ? { idleExpiresAt } : {}) };
    });
    return reply.send(docs);
  });

  // Create a production
  fastify.post('/api/v1/productions', async (req, reply) => {
    const body = ProductionInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: ProductionDoc = {
      _id: `prod-${randomUUID()}`,
      type: 'production',
      name: body.name,
      status: 'inactive',
      sources: [],
      pipeline: { stromConfig: null, status: 'stopped' },
      graphics: [],
      macros: [],
      tally: { pgm: null, pvw: null },
      createdAt: now,
      updatedAt: now,
    };
    const response = await getDb().insert(doc);
    return reply.status(201).send({ ...doc, _rev: response.rev });
  });

  // Get a production
  fastify.get<{ Params: { id: string } }>('/api/v1/productions/:id', async (req, reply) => {
    let doc: ProductionDoc;
    try {
      doc = await getDb().get(req.params.id);
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
    if (doc.status !== 'active' || !doc.stromFlowId || !doc.mixerBlockId) {
      return reply.send(doc);
    }
    try {
      const stromToken = await getStromToken(config.stromToken);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      const mixerState = await strom.mixer.getState(doc.stromFlowId, doc.mixerBlockId);
      return reply.send({ ...doc, inputResolutions: mixerState.input_resolutions });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/productions/:id — failed to fetch input_resolutions from Strom');
      return reply.send(doc);
    }
  });

  // Update a production (name, templateId)
  fastify.patch<{ Params: { id: string } }>('/api/v1/productions/:id', async (req, reply) => {
    const body = ProductionPatch.parse(req.body);
    try {
      const doc = await getDb().get(req.params.id);
      const updated: ProductionDoc = {
        ...doc,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.values !== undefined && { values: { ...(doc.values ?? {}), ...body.values } }),
        ...(body.airTime !== undefined && { airTime: body.airTime ?? undefined }),
        updatedAt: new Date().toISOString(),
      };
      const response = await getDb().insert(updated);
      return reply.send({ ...updated, _rev: response.rev });
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Delete a production
  fastify.delete<{ Params: { id: string } }>('/api/v1/productions/:id', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);

      // Cancel any in-progress activation loop
      const abortCtrl = activationAbortControllers.get(doc._id);
      if (abortCtrl) {
        abortCtrl.abort();
        activationAbortControllers.delete(doc._id);
      }

      // Stop and delete the Strom flow if one is running
      if (doc.stromFlowId) {
        const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
        await deactivateStromFlow(doc.stromFlowId, strom).catch(() => undefined);
      }

      await getDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Activate a production — immediately returns 'activating', then polls Strom
  // for flow state in a fire-and-forget async loop.
  fastify.post<{ Params: { id: string } }>(
    '/api/v1/productions/:id/activate',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);

      // Guard: reject if already active or activating
      if (doc.status === 'active' || doc.status === 'activating') {
        return reply.status(409).send({
          error: `Production is already '${doc.status}'`,
          statusCode: 409,
        });
      }

      // Guard: reject if any non-WHEP output is already active in another production
      if (doc.outputAssignments && doc.outputAssignments.length > 0) {
        const otherActiveProds = await getDb().find({
          selector: { type: 'production', status: { $in: ['active', 'activating'] } },
          fields: ['_id', 'name', 'outputAssignments'],
          limit: 200,
        });
        const activeOutputIds = new Set(
          otherActiveProds.docs.flatMap((p) =>
            ((p as unknown as ProductionDoc).outputAssignments ?? []).map((a) => a.outputId),
          ),
        );
        for (const assignment of doc.outputAssignments) {
          if (!activeOutputIds.has(assignment.outputId)) continue;
          let outputDoc: OutputDoc | undefined;
          try { outputDoc = await getOutputsDb().get(assignment.outputId); } catch { continue; }
          if (outputDoc.outputType === 'whep') continue;
          const conflictProd = otherActiveProds.docs.find((p) =>
            ((p as unknown as ProductionDoc).outputAssignments ?? []).some((a) => a.outputId === assignment.outputId),
          ) as unknown as ProductionDoc | undefined;
          return reply.status(409).send({
            error: `Output "${outputDoc.name}" is already active in production "${conflictProd?.name ?? 'another production'}"`,
            statusCode: 409,
          });
        }
      }

      // Transition to 'activating' immediately and respond; clear any deletion warnings
      const activatingDoc: ProductionDoc = {
        ...doc,
        status: 'activating',
        deletionWarnings: undefined,
        autoDeactivated: undefined,
        updatedAt: new Date().toISOString(),
      };
      const insertResponse = await getDb().insert(activatingDoc);
      notifyProductionActivated(doc._id);

      // Set up AbortController so deactivate can cancel the polling loop
      const abortController = new AbortController();
      activationAbortControllers.set(doc._id, abortController);

      // Prefer the explicitly configured PUBLIC_BASE_URL to avoid X-Forwarded-Host injection.
      // Only fall back to request-derived values when PUBLIC_BASE_URL is not set.
      const publicBaseUrl = config.publicBaseUrl
        ?? (() => {
          const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
            ?? req.protocol
            ?? 'https';
          const host = (req.headers['x-forwarded-host'] as string | undefined)
            ?? (req.headers.host as string | undefined)
            ?? req.hostname;
          return `${proto}://${host}`;
        })()

      // Fire-and-forget — must never let a rejection escape to the global handler
      void runActivationFlow(doc._id, abortController.signal, fastify.log, publicBaseUrl).catch((err) => {
        fastify.log.error({ err, productionId: doc._id }, 'Unhandled error in runActivationFlow');
      });

      return reply.send({
        id: activatingDoc._id,
        name: activatingDoc.name,
        status: activatingDoc.status,
        stromFlowId: activatingDoc.stromFlowId,
        _rev: insertResponse.rev,
      });
    } catch (err) {
      req.log.error({ err }, 'Activation failed');
      return reply.status(500).send({ error: 'Activation failed — check server logs', statusCode: 500 });
    }
  });

  // Deactivate a production — stops and deletes the Strom flow, cancels any
  // in-progress activation polling loop.
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/deactivate', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);

      // Cancel any in-progress activation loop
      const abortController = activationAbortControllers.get(doc._id);
      if (abortController) {
        abortController.abort();
        activationAbortControllers.delete(doc._id);
      }

      clearProductionPflState(doc._id);
      clearAudioState(doc._id);
      clearPipState(doc._id);
      clearFxState(doc._id);
      // Broadcast group-state reset so all connected clients clear their ephemeral
      // group assignments — these are live-only and must not survive deactivation.
      broadcast(doc._id, { type: 'GRP_STATE_RESET' });
      broadcast(doc._id, { type: 'PRODUCTION_DEACTIVATED' });
      if (doc.stromFlowId) {
        const stromToken = await getStromToken(config.stromToken).catch((err) => { req.log.error({ errMsg: err instanceof Error ? err.message : String(err) }, "SAT exchange failed — proceeding without auth"); return undefined; });
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
        await deactivateStromFlow(doc.stromFlowId, strom);
      }

      const updated: ProductionDoc = {
        ...doc,
        status: 'inactive',
        stromFlowId: undefined,
        mixerBlockId: undefined,
        audioMixerBlockId: undefined,
        loudnessMainBlockId: undefined,
        sourceOffsetBlockIds: undefined,
        sourceAudioOffsetBlockIds: undefined,
        whepEndpoint: undefined,
        pgmWhepEndpoint: undefined,
        whipEndpoints: undefined,
        srtOutputUri: undefined,
        whepOutputUrls: undefined,
        tally: { pgm: null, pvw: null },
        updatedAt: new Date().toISOString(),
      };
      const response = await getDb().insert(updated);
      notifyProductionDeactivated(doc._id);
      return reply.send({ id: updated._id, name: updated.name, status: updated.status, _rev: response.rev });
    } catch (err) {
      req.log.error({ err }, 'Deactivation failed');
      return reply.status(500).send({ error: 'Deactivation failed — check server logs', statusCode: 500 });
    }
  });

  // Assign a source to a mixer input
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/sources', async (req, reply) => {
    const body = SourceAssignmentInput.parse(req.body);
    const assignment: ProductionSourceAssignment = { sourceId: body.sourceId, mixerInput: body.mixerInput };
    for (let attempt = 0; attempt < MAX_DB_WRITE_RETRIES; attempt++) {
      try {
        const doc = await getDb().get(req.params.id);
        // Replace existing assignment for the same mixerInput, or add new
        const existing = doc.sources.findIndex((s) => s.mixerInput === body.mixerInput);
        const unsorted = existing !== -1
          ? doc.sources.map((s, i) => (i === existing ? assignment : s))
          : [...doc.sources, assignment];
        const sources = [...unsorted].sort((a, b) => a.mixerInput.localeCompare(b.mixerInput));
        const updated: ProductionDoc = { ...doc, sources, updatedAt: new Date().toISOString() };
        const response = await getDb().insert(updated);
        return reply.status(201).send({ ...assignment, _rev: response.rev });
      } catch (err) {
        if (err instanceof Error && 'statusCode' in err && (err as { statusCode?: number }).statusCode === 409) {
          if (attempt < MAX_DB_WRITE_RETRIES - 1) continue;
        }
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  });

  // Remove a source assignment by mixerInput
  fastify.delete<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/sources/:mixerInput',
    async (req, reply) => {
      const mixerInputParsed = mixerInputSchema.safeParse(req.params.mixerInput);
      if (!mixerInputParsed.success) {
        return reply.status(400).send({ error: 'Invalid mixerInput format', statusCode: 400 });
      }
      for (let attempt = 0; attempt < MAX_DB_WRITE_RETRIES; attempt++) {
        try {
          const doc = await getDb().get(req.params.id);
          const exists = doc.sources.some((s) => s.mixerInput === req.params.mixerInput);
          if (!exists) return reply.status(404).send({ error: 'Source assignment not found', statusCode: 404 });
          const updated: ProductionDoc = {
            ...doc,
            sources: doc.sources.filter((s) => s.mixerInput !== req.params.mixerInput),
            updatedAt: new Date().toISOString(),
          };
          await getDb().insert(updated);
          return reply.status(204).send();
        } catch (err) {
          if (err instanceof Error && 'statusCode' in err && (err as { statusCode?: number }).statusCode === 409) {
            if (attempt < MAX_DB_WRITE_RETRIES - 1) continue;
          }
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
      }
    }
  );

  // Assign a graphic to a DSK pad
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/graphics', async (req, reply) => {
    const body = GraphicAssignmentInput.parse(req.body);
    try {
      const doc = await getDb().get(req.params.id);
      const existing = (doc.graphicAssignments ?? []).findIndex((g) => g.dskInput === body.dskInput);
      const assignment: ProductionGraphicAssignment = { graphicId: body.graphicId, dskInput: body.dskInput };
      const graphicAssignments = existing !== -1
        ? (doc.graphicAssignments ?? []).map((g, i) => (i === existing ? assignment : g))
        : [...(doc.graphicAssignments ?? []), assignment];
      const updated: ProductionDoc = { ...doc, graphicAssignments, updatedAt: new Date().toISOString() };
      const response = await getDb().insert(updated);
      return reply.status(201).send({ ...assignment, _rev: response.rev });
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Remove a graphic assignment by DSK pad
  fastify.delete<{ Params: { id: string; dskInput: string } }>(
    '/api/v1/productions/:id/graphics/:dskInput',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        const exists = (doc.graphicAssignments ?? []).some((g) => g.dskInput === req.params.dskInput);
        if (!exists) return reply.status(404).send({ error: 'Graphic assignment not found', statusCode: 404 });
        const updated: ProductionDoc = {
          ...doc,
          graphicAssignments: (doc.graphicAssignments ?? []).filter((g) => g.dskInput !== req.params.dskInput),
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updated);
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );

  // Assign an output to a production
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/outputs', async (req, reply) => {
    const body = OutputAssignmentInput.parse(req.body);
    try {
      const doc = await getDb().get(req.params.id);
      const already = (doc.outputAssignments ?? []).some((o) => o.outputId === body.outputId);
      if (already) return reply.status(409).send({ error: 'Output already assigned', statusCode: 409 });
      const assignment: ProductionOutputAssignment = { outputId: body.outputId };
      const outputAssignments = [...(doc.outputAssignments ?? []), assignment];
      const updated: ProductionDoc = { ...doc, outputAssignments, updatedAt: new Date().toISOString() };
      const response = await getDb().insert(updated);
      return reply.status(201).send({ ...assignment, _rev: response.rev });
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Remove an output assignment
  fastify.delete<{ Params: { id: string; outputId: string } }>(
    '/api/v1/productions/:id/outputs/:outputId',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        const exists = (doc.outputAssignments ?? []).some((o) => o.outputId === req.params.outputId);
        if (!exists) return reply.status(404).send({ error: 'Output assignment not found', statusCode: 404 });
        const updated: ProductionDoc = {
          ...doc,
          outputAssignments: (doc.outputAssignments ?? []).filter((o) => o.outputId !== req.params.outputId),
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updated);
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );
  // Connected controller count for a production (used by the companion module
  // to show a "peers connected" indicator on the landing page)
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/productions/:id/controllers',
    async (req, reply) => {
      return reply.send({ count: getSubscriberCount(req.params.id) });
    }
  );
};

export { activationAbortControllers };
export default productionsRoutes;
