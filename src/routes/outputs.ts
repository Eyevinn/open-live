import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getOutputsDb, getDb } from '../db/index.js';
import type { OutputDoc, ProductionDoc } from '../db/types.js';
import { updateProductionDoc } from './productions.js';
import { srtUrl } from '../lib/url-validation.js';
import { getPortLease } from '../services/port-lease.js';
import { clashesAfterWrite, listenerPortRequest, resolveListenerAddress, usedListenerPorts } from '../services/listener-ports.js';

const SRT_OUTPUT_TYPES = new Set(['mpegtssrt', 'efpsrt']);

const OutputInput = z.object({
  name: z.string().min(1).max(256),
  outputType: z.enum(['mpegtssrt', 'efpsrt', 'whep']),
  url: z.string().optional(),
}).superRefine((data, ctx) => {
  if (SRT_OUTPUT_TYPES.has(data.outputType) && data.url) {
    try {
      srtUrl(data.url);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: err instanceof Error ? err.message : 'Invalid SRT URL' });
    }
  }
});

const OutputPatch = z.object({
  name: z.string().min(1).max(256).optional(),
  url: z.string().optional(),
});

function toApi(doc: OutputDoc) {
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
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
    return reply.send((Array.isArray(result?.docs) ? result.docs : []).map(toApi));
  });

  fastify.post('/api/v1/outputs', async (req, reply) => {
    const body = OutputInput.parse(req.body);
    const isSrt = SRT_OUTPUT_TYPES.has(body.outputType) && !!body.url;
    const id = `output-${randomUUID()}`;
    // A listener output binds a port on the shared Strom, like a listener source
    // does: same range, same uniqueness, same port-0 assignment, same re-check.
    let used = isSrt ? await usedListenerPorts() : [];
    for (let attempt = 0; ; attempt++) {
      let url = body.url;
      let port: number | null = null;
      if (isSrt && url) {
        const resolved = resolveListenerAddress(url, getPortLease(), used);
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
        url,
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
      return reply.send(toApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Output not found', statusCode: 404 });
    }
  });

  fastify.patch<{ Params: { id: string } }>('/api/v1/outputs/:id', async (req, reply) => {
    const body = OutputPatch.parse(req.body);
    try {
      const doc = await getOutputsDb().get(req.params.id);
      // Validate the effective URL if output type is SRT-based
      const effectiveUrl = body.url ?? doc.url;
      if (SRT_OUTPUT_TYPES.has(doc.outputType) && effectiveUrl) {
        try {
          srtUrl(effectiveUrl);
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid SRT URL' });
        }
        // Re-check the port only when the URL changes — a rename must not fail
        // because an older output predates the lease. Port 0 keeps the current one.
        if (body.url !== undefined) {
          const resolved = resolveListenerAddress(effectiveUrl, getPortLease(), await usedListenerPorts(), {
            exclude: { kind: 'output', id: doc._id },
            keep: doc.url ? listenerPortRequest(doc.url) : null,
          });
          if (!resolved.ok) {
            return reply.status(resolved.statusCode).send({ error: resolved.error, statusCode: resolved.statusCode });
          }
          body.url = resolved.address;
        }
      }
      const updated: OutputDoc = { ...doc, ...body, updatedAt: new Date().toISOString() };
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
