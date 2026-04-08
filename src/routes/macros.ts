import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import type { Macro, ProductionDoc } from '../db/types.js';

const MacroActionSchema = z.object({
  type: z.enum(['CUT', 'TRANSITION', 'TAKE', 'GRAPHIC_ON', 'GRAPHIC_OFF', 'DSK_TOGGLE']),
  sourceId: z.string().optional(),
  transitionType: z.string().optional(),
  durationMs: z.number().int().positive().optional(),
  overlayId: z.string().optional(),
  layer: z.number().int().min(0).optional(),
  visible: z.boolean().optional(),
});

const MacroInput = z.object({
  slot: z.number().int().min(0).max(7),
  label: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  actions: z.array(MacroActionSchema).default([]),
});

const MacroPatch = z.object({
  slot: z.number().int().min(0).max(7).optional(),
  label: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  actions: z.array(MacroActionSchema).optional(),
});

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { statusCode?: number; error?: string };
      if (e?.statusCode === 409 || e?.error === 'conflict') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const macrosRoutes: FastifyPluginAsync = async (fastify) => {
  // List macros for a production
  fastify.get<{ Params: { id: string } }>('/api/v1/productions/:id/macros', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);
      return reply.send(doc.macros ?? []);
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Create a macro
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/macros', async (req, reply) => {
    const body = MacroInput.parse(req.body);
    const macro: Macro = {
      id: `macro-${randomUUID()}`,
      slot: body.slot,
      label: body.label,
      color: body.color,
      actions: body.actions,
    };

    await withRetry(async () => {
      const doc = await getDb().get(req.params.id);
      const updated: ProductionDoc = {
        ...doc,
        macros: [...(doc.macros ?? []), macro],
        updatedAt: new Date().toISOString(),
      };
      await getDb().insert(updated);
    });

    return reply.status(201).send(macro);
  });

  // Update a macro
  fastify.patch<{ Params: { id: string; macroId: string } }>(
    '/api/v1/productions/:id/macros/:macroId',
    async (req, reply) => {
      const body = MacroPatch.parse(req.body);
      let updated: Macro | undefined;

      await withRetry(async () => {
        const doc = await getDb().get(req.params.id);
        const idx = (doc.macros ?? []).findIndex((m) => m.id === req.params.macroId);
        if (idx === -1) return; // handled after loop

        updated = {
          ...(doc.macros ?? [])[idx],
          ...(body.slot !== undefined && { slot: body.slot }),
          ...(body.label !== undefined && { label: body.label }),
          ...(body.color !== undefined && { color: body.color }),
          ...(body.actions !== undefined && { actions: body.actions }),
        };

        const updatedDoc: ProductionDoc = {
          ...doc,
          macros: (doc.macros ?? []).map((m, i) => (i === idx ? updated! : m)),
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updatedDoc);
      });

      if (!updated) {
        return reply.status(404).send({ error: 'Macro not found', statusCode: 404 });
      }
      return reply.send(updated);
    },
  );

  // Delete a macro
  fastify.delete<{ Params: { id: string; macroId: string } }>(
    '/api/v1/productions/:id/macros/:macroId',
    async (req, reply) => {
      let found = false;

      await withRetry(async () => {
        const doc = await getDb().get(req.params.id);
        found = (doc.macros ?? []).some((m) => m.id === req.params.macroId);
        if (!found) return;

        const updatedDoc: ProductionDoc = {
          ...doc,
          macros: (doc.macros ?? []).filter((m) => m.id !== req.params.macroId),
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updatedDoc);
      });

      if (!found) {
        return reply.status(404).send({ error: 'Macro not found', statusCode: 404 });
      }
      return reply.status(204).send();
    },
  );
};

export default macrosRoutes;
