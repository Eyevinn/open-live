import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import type { ProductionDoc, ProductionSourceAssignment } from '../db/types.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { activateStromFlow, deactivateStromFlow } from '../lib/flow-generator.js';
import { config } from '../config.js';

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

  // Activate a production — creates and starts a Strom flow
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/activate', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);

      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });

      let stromFlowId: string | undefined;
      let stromVersion: string | null = null;

      // Fetch Strom version (best-effort)
      stromVersion = await strom.system.version()
        .then((info) => info.version)
        .catch(() => null);

      // Start Strom flow if a template is configured
      let mixerBlockId: string | undefined;
      if (doc.templateId) {
        stromFlowId = await activateStromFlow(doc, strom);

        // Resolve mixer block ID from template for DSK/transition operations
        const tmpl = await getDb().get(doc.templateId).catch(() => null);
        if (tmpl) {
          const mixerBlock = (tmpl as unknown as { flow?: { blocks?: Array<Record<string, unknown>> } })
            .flow?.blocks?.find((b) => b['category'] === 'mixer');
          if (mixerBlock && typeof mixerBlock['id'] === 'string') {
            mixerBlockId = mixerBlock['id'];
          }
        }
      }

      const updated: ProductionDoc = {
        ...doc,
        status: 'active',
        ...(stromFlowId !== undefined && { stromFlowId }),
        ...(mixerBlockId !== undefined && { mixerBlockId }),
        updatedAt: new Date().toISOString(),
      };
      const response = await getDb().insert(updated);

      return reply.send({
        id: updated._id,
        name: updated.name,
        status: updated.status,
        stromFlowId: updated.stromFlowId,
        stromVersion,
        _rev: response.rev,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Failed to activate production');
      return reply.status(500).send({ error: message, statusCode: 500 });
    }
  });

  // Deactivate a production — stops and deletes the Strom flow
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/deactivate', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);

      if (doc.stromFlowId) {
        const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
        await deactivateStromFlow(doc.stromFlowId, strom);
      }

      const updated: ProductionDoc = {
        ...doc,
        status: 'inactive',
        stromFlowId: undefined,
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

export default productionsRoutes;
