import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getGraphicsDb, getDb } from '../db/index.js';
import type { GraphicDoc, ProductionDoc } from '../db/types.js';
import { updateProductionDoc } from './productions.js';
import { graphicUrl } from '../lib/url-validation.js';

// Accept only safe http/https URLs or data:image/(png|jpeg|gif|webp) base64 URIs.
// Rejects file://, javascript:, data:text/html, data:image/svg+xml, etc.
// 512 KB cap prevents CouchDB storage exhaustion via large data URIs.
const safeGraphicUrl = z.string().min(1).max(524288).superRefine((s, ctx) => {
  try {
    graphicUrl(s);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : 'Invalid graphic URL' });
  }
});

const GraphicInput = z.object({
  name: z.string().min(1).max(256),
  url: safeGraphicUrl,
});

const GraphicPatch = z.object({
  name: z.string().min(1).max(256).optional(),
  url: safeGraphicUrl.optional(),
});

function toApi(doc: GraphicDoc) {
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

const graphicsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/graphics', async (_req, reply) => {
    const db = getGraphicsDb();
    let result: Awaited<ReturnType<typeof db.find>>;
    try {
      result = await db.find({ selector: { type: 'graphic' } });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/graphics — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable' });
    }
    return reply.send((Array.isArray(result?.docs) ? result.docs : []).map(toApi));
  });

  fastify.post('/api/v1/graphics', async (req, reply) => {
    const body = GraphicInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: GraphicDoc = {
      _id: `gfx-${randomUUID()}`,
      type: 'graphic',
      name: body.name,
      url: body.url,
      createdAt: now,
      updatedAt: now,
    };
    await getGraphicsDb().insert(doc);
    return reply.status(201).send(toApi(doc));
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/graphics/:id', async (req, reply) => {
    try {
      const doc = await getGraphicsDb().get(req.params.id);
      return reply.send(toApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Graphic not found', statusCode: 404 });
    }
  });

  fastify.patch<{ Params: { id: string } }>('/api/v1/graphics/:id', async (req, reply) => {
    const body = GraphicPatch.parse(req.body);
    try {
      const doc = await getGraphicsDb().get(req.params.id);
      const updated: GraphicDoc = { ...doc, ...body, updatedAt: new Date().toISOString() };
      await getGraphicsDb().insert(updated);
      return reply.send(toApi(updated));
    } catch {
      return reply.status(404).send({ error: 'Graphic not found', statusCode: 404 });
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/v1/graphics/:id', async (req, reply) => {
    try {
      const doc = await getGraphicsDb().get(req.params.id);

      // Block deletion if the graphic is assigned to an active or activating production
      const allProductions = await getDb().find({
        selector: { type: 'production' },
        fields: ['_id', 'name', 'status', 'graphicAssignments', 'deletionWarnings'],
        limit: 200,
      });
      const activeInUse = allProductions.docs.find((p) => {
        const prod = p as unknown as ProductionDoc;
        return (prod.status === 'active' || prod.status === 'activating') &&
          (prod.graphicAssignments ?? []).some((a) => a.graphicId === req.params.id);
      });
      if (activeInUse) {
        const prod = activeInUse as unknown as Pick<ProductionDoc, '_id' | 'name'>;
        return reply.status(409).send({ error: `Graphic is in use by active production "${prod.name}"` });
      }

      // Remove references from inactive productions and record a warning
      for (const p of allProductions.docs) {
        const prod = p as unknown as ProductionDoc;
        if (prod.status !== 'inactive') continue;
        if (!(prod.graphicAssignments ?? []).some((a) => a.graphicId === req.params.id)) continue;
        const warnings = prod.deletionWarnings ?? [];
        warnings.push({ type: 'graphic', name: doc.name });
        await updateProductionDoc(prod._id, {
          graphicAssignments: (prod.graphicAssignments ?? []).filter((a) => a.graphicId !== req.params.id),
          deletionWarnings: warnings,
        });
      }

      await getGraphicsDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Graphic not found' });
      }
      throw err;
    }
  });
};

export default graphicsRoutes;
