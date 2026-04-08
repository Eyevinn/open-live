import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getTemplatesDb } from '../db/index.js';
import type { StromFlowTemplate, AudioElement } from '../db/types.js';

// Flow content uses open-ended schemas to accommodate the full Strom block
// shape (block_definition_id, position, computed_external_pads, etc.) as
// well as Strom's "from":"id:pad" link shorthand from GET responses.
const FlowElementSchema = z.record(z.unknown()).refine(
  (v) => typeof v['id'] === 'string',
  { message: 'element must have an id string' },
);

const FlowLinkSchema = z.record(z.unknown());

const FlowBlockSchema = z.record(z.unknown()).refine(
  (v) => typeof v['id'] === 'string',
  { message: 'block must have an id string' },
);

const TemplateInputSlotSchema = z.object({
  id: z.string().min(1),
  blockId: z.string().min(1),
  addressProperty: z.string().min(1),
});

const AudioElementSchema = z.object({
  id: z.string().min(1),
  blockId: z.string().min(1),
  elementId: z.string().min(1),
  label: z.string().min(1),
});

const TemplateInput = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  flow: z.object({
    elements: z.array(FlowElementSchema).default([]),
    blocks: z.array(FlowBlockSchema).default([]),
    links: z.array(FlowLinkSchema).default([]),
  }),
  inputs: z.array(TemplateInputSlotSchema).default([]),
  audioElements: z.array(AudioElementSchema).default([]),
});

const TemplatePatch = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  flow: z.object({
    elements: z.array(FlowElementSchema).optional(),
    blocks: z.array(FlowBlockSchema).optional(),
    links: z.array(FlowLinkSchema).optional(),
  }).optional(),
  inputs: z.array(TemplateInputSlotSchema).optional(),
  audioElements: z.array(AudioElementSchema).optional(),
});

function toApi(doc: StromFlowTemplate) {
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

const templatesRoutes: FastifyPluginAsync = async (fastify) => {
  // List all templates
  fastify.get('/api/v1/templates', async (_req, reply) => {
    const db = getTemplatesDb();
    const result = await db.find({ selector: { type: 'template' } });
    return reply.send(result.docs.map((doc) => toApi(doc as unknown as StromFlowTemplate)));
  });

  // Create a template
  fastify.post('/api/v1/templates', async (req, reply) => {
    const body = TemplateInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: StromFlowTemplate = {
      _id: `tmpl-${randomUUID()}`,
      type: 'template',
      name: body.name,
      description: body.description,
      flow: body.flow,
      inputs: body.inputs,
      audioElements: body.audioElements as AudioElement[],
      createdAt: now,
      updatedAt: now,
    };
    await getTemplatesDb().insert(doc as never);
    return reply.status(201).send(toApi(doc));
  });

  // Get a template
  fastify.get<{ Params: { id: string } }>('/api/v1/templates/:id', async (req, reply) => {
    try {
      const doc = await getTemplatesDb().get(req.params.id);
      return reply.send(toApi(doc as unknown as StromFlowTemplate));
    } catch {
      return reply.status(404).send({ error: 'Template not found', statusCode: 404 });
    }
  });

  // Update a template
  fastify.patch<{ Params: { id: string } }>('/api/v1/templates/:id', async (req, reply) => {
    const body = TemplatePatch.parse(req.body);
    try {
      const existing = await getTemplatesDb().get(req.params.id);
      const doc = existing as unknown as StromFlowTemplate;
      const updated: StromFlowTemplate = {
        ...doc,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.flow !== undefined && {
          flow: {
            elements: body.flow.elements ?? doc.flow.elements,
            blocks: body.flow.blocks ?? doc.flow.blocks,
            links: body.flow.links ?? doc.flow.links,
          },
        }),
        ...(body.inputs !== undefined && { inputs: body.inputs }),
        ...(body.audioElements !== undefined && { audioElements: body.audioElements as AudioElement[] }),
        updatedAt: new Date().toISOString(),
      };
      const response = await getTemplatesDb().insert(updated as never);
      return reply.send({ ...toApi(updated), _rev: response.rev });
    } catch {
      return reply.status(404).send({ error: 'Template not found', statusCode: 404 });
    }
  });

  // Delete a template
  fastify.delete<{ Params: { id: string } }>('/api/v1/templates/:id', async (req, reply) => {
    try {
      const doc = await getTemplatesDb().get(req.params.id);
      await getTemplatesDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch {
      return reply.status(404).send({ error: 'Template not found', statusCode: 404 });
    }
  });
};

export default templatesRoutes;
