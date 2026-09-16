import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { loadAudioChannels } from '../lib/audio-channels.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';

const AudioPatch = z.object({
  property: z.enum(['volume', 'mute']),
  // volume: 0.0–10.0 (Strom mixer ceiling); mute: boolean
  value: z.union([z.number().min(0).max(10), z.boolean()]),
});

const MIXER_BLOCK_TYPE = 'builtin.mixer';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Strom request timed out')), ms),
    ),
  ]);
}

function chNum(elementId: string): number | null {
  const m = /^ch(\d+)$/.exec(elementId);
  return m ? parseInt(m[1], 10) : null;
}

const audioRoutes: FastifyPluginAsync = async (fastify) => {
  // Discover audio channels from the builtin.mixer block.
  // Reads num_channels from the block's properties and returns synthetic
  // channel descriptors ch1..chN. The mixer block is opaque — its internal
  // elements don't appear in flow.elements, so we generate them here.
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/productions/:id/audio',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        if (!doc.stromFlowId) {
          return reply.status(409).send({ error: 'Pipeline not active', statusCode: 409 });
        }
        const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
        const { flow } = await withTimeout(strom.flows.get(doc.stromFlowId), 5000);

        const mixerBlock = (flow.blocks ?? []).find(
          (b) => b.block_definition_id === MIXER_BLOCK_TYPE,
        );
        if (!mixerBlock) return reply.send([]);

        const rawNumCh = mixerBlock.properties?.num_channels;
        const numChannels = typeof rawNumCh === 'number' ? rawNumCh as number
          : typeof rawNumCh === 'string' ? parseInt(rawNumCh, 10)
          : 0;
        if (!numChannels || isNaN(numChannels)) return reply.send([]);

        // Build audio-channel-index → source name / mixerInput maps.
        const audioChannelNameMap = new Map<number, string>();
        const audioChannelMixerInputMap = new Map<number, string>();
        try {
          for (const { channel, assignment, source } of await loadAudioChannels(doc.sources ?? [])) {
            audioChannelNameMap.set(channel, source.name);
            audioChannelMixerInputMap.set(channel, assignment.mixerInput);
          }
        } catch { /* sources DB unavailable */ }

        const channels = Array.from({ length: numChannels }, (_, i) => {
          const chIdx = i + 1;
          const label =
            audioChannelNameMap.get(i) ??
            (mixerBlock.properties?.[`ch${chIdx}_label`] as string | undefined) ??
            `Ch ${chIdx}`;
          return { id: `ch${chIdx}`, elementId: `ch${chIdx}`, blockId: mixerBlock.id, label, mixerInput: audioChannelMixerInputMap.get(i) ?? null };
        });

        // MAIN is always the master output strip of the mixer
        const main = { id: 'main', elementId: 'main', blockId: mixerBlock.id, label: 'MAIN', mixerInput: null };

        return reply.send([...channels, main]);
      } catch (err) {
        const e = err as { statusCode?: number };
        if (e?.statusCode === 404) {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        throw err;
      }
    },
  );

  // Get a channel's current fader and mute state from the mixer block properties
  fastify.get<{ Params: { id: string; elementId: string } }>(
    '/api/v1/productions/:id/audio/:elementId',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        if (!doc.stromFlowId) {
          return reply.status(409).send({ error: 'Pipeline not active', statusCode: 409 });
        }
        const isMain = req.params.elementId === 'main';
        const ch = isMain ? null : chNum(req.params.elementId);
        if (!isMain && ch === null) {
          return reply.status(400).send({ error: 'Invalid channel id', statusCode: 400 });
        }
        const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
        const { flow } = await withTimeout(strom.flows.get(doc.stromFlowId), 5000);

        const mixerBlock = (flow.blocks ?? []).find(
          (b) => b.block_definition_id === MIXER_BLOCK_TYPE,
        );
        if (!mixerBlock) {
          return reply.status(404).send({ error: 'Mixer block not found', statusCode: 404 });
        }
        const elemId = isMain ? `${mixerBlock.id}:main_volume` : `${mixerBlock.id}:volume_${(ch as number) - 1}`;
        const elemProps = await withTimeout(strom.properties.getElement(doc.stromFlowId, elemId), 5000).catch(() => null);
        return reply.send({
          element_id: req.params.elementId,
          properties: {
            volume: typeof elemProps?.properties['volume'] === 'number' ? elemProps.properties['volume'] : 1.0,
            mute: typeof elemProps?.properties['mute'] === 'boolean' ? elemProps.properties['mute'] : false,
          },
        });
      } catch (err) {
        const e = err as { statusCode?: number };
        if (e?.statusCode === 404) {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        throw err;
      }
    },
  );

  // Update a channel's fader (volume) or mute via builtin.mixer flow properties.
  // elementId is 'ch1', 'ch2', etc. — mapped to ch{N}_fader / ch{N}_mute.
  fastify.patch<{ Params: { id: string; elementId: string } }>(
    '/api/v1/productions/:id/audio/:elementId',
    async (req, reply) => {
      const body = AudioPatch.parse(req.body);
      try {
        const doc = await getDb().get(req.params.id);
        if (!doc.stromFlowId) {
          return reply.status(409).send({ error: 'Pipeline not active', statusCode: 409 });
        }
        const isMain = req.params.elementId === 'main';
        const ch = isMain ? null : chNum(req.params.elementId);
        if (!isMain && ch === null) {
          return reply.status(400).send({ error: 'Invalid channel id', statusCode: 400 });
        }
        const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });

        const { flow } = await withTimeout(strom.flows.get(doc.stromFlowId), 5000);
        const mixerBlock2 = (flow.blocks ?? []).find((b) => b.block_definition_id === MIXER_BLOCK_TYPE);
        if (!mixerBlock2) return reply.status(404).send({ error: 'Mixer block not found', statusCode: 404 });

        const elemId = isMain ? `${mixerBlock2.id}:main_volume` : `${mixerBlock2.id}:volume_${(ch as number) - 1}`;
        const property = body.property === 'volume' ? 'volume' : 'mute';
        await withTimeout(
          strom.properties.updateElement(doc.stromFlowId, elemId, { property_name: property, value: body.value }),
          5000,
        );
        return reply.send({ element_id: req.params.elementId, properties: { [body.property]: body.value } });
      } catch (err) {
        const e = err as { statusCode?: number };
        if (e?.statusCode === 404) {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        throw err;
      }
    },
  );
};

export default audioRoutes;
