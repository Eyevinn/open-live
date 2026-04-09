import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import type { ProductionDoc, ProductionSourceAssignment } from '../db/types.js';
import { StromClient, StromClientError } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { activateStromFlow, deactivateStromFlow } from '../lib/flow-generator.js';
import { config } from '../config.js';

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
): Promise<void> {
  let stromFlowId: string | undefined;
  let mixerBlockId: string | undefined;

  try {
    // Load the current production doc
    const doc = await getDb().get(productionId);

    const stromToken = await getStromToken(config.stromToken);
    const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });

    // Step 1: Start the Strom flow
    if (signal.aborted) return;
    stromFlowId = await activateStromFlow(doc, strom);

    // Resolve mixerBlockId from template
    if (doc.templateId) {
      const tmpl = await getDb().get(doc.templateId).catch(() => null);
      if (tmpl) {
        const mixerBlock = (tmpl as unknown as { flow?: { blocks?: Array<Record<string, unknown>> } })
          .flow?.blocks?.find((b) => (b['block_definition_id'] as string | undefined)?.includes('vision_mixer'));
        if (mixerBlock && typeof mixerBlock['id'] === 'string') {
          mixerBlockId = mixerBlock['id'];
        }
      }
    }

    // Step 2: Persist stromFlowId + mixerBlockId
    if (signal.aborted) {
      await deactivateStromFlow(stromFlowId, strom).catch(() => undefined);
      return;
    }
    await updateProductionDoc(productionId, {
      stromFlowId,
      ...(mixerBlockId !== undefined && { mixerBlockId }),
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

        await updateProductionDoc(productionId, {
          status: 'active',
          whepEndpoint,
        });

        log.info({ productionId, stromFlowId, whepEndpoint }, 'Production activated — flow playing');
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
      const stromToken = await getStromToken(config.stromToken).catch((err) => { log.error({ err }, "SAT exchange failed — proceeding without auth"); return undefined; });
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      await deactivateStromFlow(stromFlowId, strom).catch(() => undefined);
    }

    // Reset production to inactive, clearing all flow-related fields
    await updateProductionDoc(productionId, {
      status: 'inactive',
      stromFlowId: undefined,
      mixerBlockId: undefined,
      whepEndpoint: undefined,
    }).catch((resetErr) => {
      log.error({ resetErr, productionId }, 'Failed to reset production to inactive after activation failure');
    });
  } finally {
    activationAbortControllers.delete(productionId);
  }
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ProductionInput = z.object({
  name: z.string().min(1),
});

const ProductionPatch = z.object({
  name: z.string().min(1).optional(),
  templateId: z.string().nullable().optional(),
});

const SourceAssignmentInput = z.object({
  sourceId: z.string().min(1),
  mixerInput: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const productionsRoutes: FastifyPluginAsync = async (fastify) => {
  // List all productions
  fastify.get('/api/v1/productions', async (_req, reply) => {
    const db = getDb();
    const result = await db.find({ selector: { type: 'production' } });
    return reply.send(result.docs);
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
    try {
      const doc = await getDb().get(req.params.id);
      return reply.send(doc);
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
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
        ...(body.templateId !== undefined && {
          templateId: body.templateId ?? undefined,
        }),
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
      await getDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Activate a production — immediately returns 'activating', then polls Strom
  // for flow state in a fire-and-forget async loop.
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/activate', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);

      // Guard: reject if already active or activating
      if (doc.status === 'active' || doc.status === 'activating') {
        return reply.status(409).send({
          error: `Production is already '${doc.status}'`,
          statusCode: 409,
        });
      }

      // Transition to 'activating' immediately and respond
      const activatingDoc: ProductionDoc = {
        ...doc,
        status: 'activating',
        updatedAt: new Date().toISOString(),
      };
      const insertResponse = await getDb().insert(activatingDoc);

      // Set up AbortController so deactivate can cancel the polling loop
      const abortController = new AbortController();
      activationAbortControllers.set(doc._id, abortController);

      // Fire-and-forget — must never let a rejection escape to the global handler
      void runActivationFlow(doc._id, abortController.signal, fastify.log).catch((err) => {
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
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Failed to initiate production activation');
      return reply.status(500).send({ error: message, statusCode: 500 });
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

      if (doc.stromFlowId) {
        const stromToken = await getStromToken(config.stromToken).catch((err) => { req.log.error({ err }, "SAT exchange failed — proceeding without auth"); return undefined; });
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
        await deactivateStromFlow(doc.stromFlowId, strom);
      }

      const updated: ProductionDoc = {
        ...doc,
        status: 'inactive',
        stromFlowId: undefined,
        mixerBlockId: undefined,
        whepEndpoint: undefined,
        updatedAt: new Date().toISOString(),
      };
      const response = await getDb().insert(updated);
      return reply.send({ id: updated._id, name: updated.name, status: updated.status, _rev: response.rev });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Failed to deactivate production');
      return reply.status(500).send({ error: message, statusCode: 500 });
    }
  });

  // Assign a source to a mixer input
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/sources', async (req, reply) => {
    const body = SourceAssignmentInput.parse(req.body);
    try {
      const doc = await getDb().get(req.params.id);
      // Replace existing assignment for the same mixerInput, or add new
      const existing = doc.sources.findIndex((s) => s.mixerInput === body.mixerInput);
      const assignment: ProductionSourceAssignment = { sourceId: body.sourceId, mixerInput: body.mixerInput };
      const sources = existing !== -1
        ? doc.sources.map((s, i) => (i === existing ? assignment : s))
        : [...doc.sources, assignment];
      const updated: ProductionDoc = { ...doc, sources, updatedAt: new Date().toISOString() };
      const response = await getDb().insert(updated);
      return reply.status(201).send({ ...assignment, _rev: response.rev });
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Remove a source assignment by mixerInput
  fastify.delete<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/sources/:mixerInput',
    async (req, reply) => {
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
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );
};

export { activationAbortControllers };
export default productionsRoutes;
