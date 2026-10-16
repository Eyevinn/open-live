import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb, getGuestInvitesDb, getGuestSessionsDb } from '../db/index.js';
import { loadAudioChannels } from '../lib/audio-channels.js';
import { guestSlotDefaultLabel } from '../lib/guest-slot-label.js';
import { StromClient, StromPropertiesRejectedError } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';
import { broadcast } from '../services/tally.service.js';
import { updateProductionDoc } from './productions.js';
import {
  type AudioProcStage,
  AUDIO_PROC_STAGES,
  parseStageParams,
  stageAllowedOnElement,
  stageToStromProps,
  mergeIntoStore,
  defaultStageParams,
  mergeStageParams,
  stagesForElement,
} from '../lib/audio-processing.js';

const AudioPatch = z.object({
  property: z.enum(['volume', 'mute']),
  // volume: 0.0–10.0 (Strom mixer ceiling); mute: boolean
  value: z.union([z.number().min(0).max(10), z.boolean()]),
});

// Audio processing PATCH envelope (issue #527). `params` is range-validated
// per-stage against the Strom ranges in the handler (shared with the WS path).
const AudioProcPatch = z.object({
  stage: z.enum(AUDIO_PROC_STAGES),
  params: z.record(z.string(), z.unknown()),
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
        // Channels that are WHIP guest slots. For these, the generic virtual-source
        // name is "WHIP Input" (audio-channels.ts VIRTUAL_SOURCES['Whip']), so the
        // "Guest N" value the flow generator wrote to ch{N}_label must WIN over that
        // name — otherwise every guest strip reads "WHIP Input" (issue #464). A WHIP
        // guest slot is detected exactly as flow-generator.ts does: an assignment
        // carrying a `returnFeed` whose source resolves to streamType 'whip'. Plain
        // WHIP inputs (no returnFeed) and every other source keep their own name.
        const guestWhipChannels = new Set<number>();
        try {
          for (const { channel, assignment, source } of await loadAudioChannels(doc.sources ?? [])) {
            audioChannelNameMap.set(channel, source.name);
            audioChannelMixerInputMap.set(channel, assignment.mixerInput);
            if (assignment.returnFeed && source.streamType === 'whip') {
              guestWhipChannels.add(channel);
            }
          }
        } catch { /* sources DB unavailable */ }

        // Resolve the JOINED guest's invite name onto its slot's strip (issue #522).
        // The flow writes the build-time "Guest N" to ch{N}_label, but ch{N}_label
        // is NOT a live Strom property ("requires flow restart"), so the join-time
        // live PATCH is refused and the stale "Guest N" is what a read-back of the
        // flow would return. open-live already holds the joined guest's name
        // server-side (the active guest-session's invite `label`), so we resolve the
        // strip label from there instead — this survives a controller reload and
        // falls back to "Guest N" the moment the guest leaves. Best-effort: if the
        // guest DBs are unavailable the strip simply keeps its "Guest N" default.
        const guestNameByMixerInput = new Map<string, string>();
        try {
          const sessionsResult = await getGuestSessionsDb().find({
            selector: { type: 'guest-session', productionId: req.params.id },
          });
          const sessions = (Array.isArray(sessionsResult?.docs) ? sessionsResult.docs : [])
            .filter((s) => s.state !== 'left');
          if (sessions.length > 0) {
            const invitesResult = await getGuestInvitesDb().find({
              selector: { type: 'guest-invite', productionId: req.params.id },
            });
            const labelByInvite = new Map(
              (Array.isArray(invitesResult?.docs) ? invitesResult.docs : [])
                .map((inv) => [inv._id, inv.label] as const),
            );
            for (const s of sessions) {
              const name = labelByInvite.get(s.inviteId)?.trim();
              if (name) guestNameByMixerInput.set(s.mixerInput, name);
            }
          }
        } catch { /* guest DBs unavailable — fall back to the "Guest N" default */ }

        const channels = Array.from({ length: numChannels }, (_, i) => {
          const chIdx = i + 1;
          const chLabel = mixerBlock.properties?.[`ch${chIdx}_label`] as string | undefined;
          const mixerInput = audioChannelMixerInputMap.get(i) ?? null;
          // Guest slots: prefer the joined guest's invite name (issue #522), then the
          // "Guest N" default (NOT the stale ch{N}_label read back from the flow, which
          // Strom refuses to live-update), ahead of the generic "WHIP Input" name.
          // Everything else keeps the resolved source name first, falling back to the
          // flow label then "Ch N".
          const label = guestWhipChannels.has(i)
            ? ((mixerInput ? guestNameByMixerInput.get(mixerInput) : undefined)
                ?? (mixerInput ? guestSlotDefaultLabel(doc, mixerInput) : undefined)
                ?? chLabel ?? audioChannelNameMap.get(i) ?? `Ch ${chIdx}`)
            : (audioChannelNameMap.get(i) ?? chLabel ?? `Ch ${chIdx}`);
          return { id: `ch${chIdx}`, elementId: `ch${chIdx}`, blockId: mixerBlock.id, label, mixerInput };
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
        // The write reached Strom: tell every connected controller client what was
        // applied, in the same AUDIO_STATE shape the WS mixer path uses, so a REST
        // fader/mute change no longer leaves live UIs stale. Additive `applied: true`
        // marks it as a confirmed-at-Strom value; clients that ignore the flag still work.
        broadcast(req.params.id, {
          type: 'AUDIO_STATE',
          elementId: req.params.elementId,
          property: body.property,
          value: body.value,
          applied: true,
        });
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

  // Get an element's current audio processing state (issue #527, OL-25). Returns
  // every stage valid on the element — gain/hpf/gate/comp/eq on a channel;
  // comp/eq/limiter on main — with Strom defaults overlaid by any persisted
  // operator changes, so a never-touched production reports the defaults.
  fastify.get<{ Params: { id: string; elementId: string } }>(
    '/api/v1/productions/:id/audio/:elementId/processing',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        const elementId = req.params.elementId;
        const isMain = elementId === 'main';
        const ch = isMain ? null : chNum(elementId);
        if (!isMain && ch === null) {
          return reply.status(400).send({ error: 'Invalid channel id', statusCode: 400 });
        }
        const store = doc.audioProcessing;
        const processing: Record<string, unknown> = {};
        for (const stage of stagesForElement(elementId)) {
          const stored = store?.[elementId]?.[stage];
          processing[stage] = mergeStageParams(stage, defaultStageParams(stage), stored ?? {});
        }
        return reply.send({ element_id: elementId, processing });
      } catch (err) {
        const e = err as { statusCode?: number };
        if (e?.statusCode === 404) {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        throw err;
      }
    },
  );

  // Update an element's audio processing (issue #527, OL-25). Same params as the
  // WS AUDIO_PROC_SET: validated against the Strom ranges (out-of-range → 400,
  // no silent clamp), persisted on the production doc, applied live to Strom
  // when the pipeline is running, and broadcast as AUDIO_PROC_STATE so live WS
  // clients stay in sync. The construction-time ch{N}_hpf_enabled flag is
  // persisted but only takes effect on the next activation (via the flow
  // generator) — the live write carries just the live keys.
  fastify.patch<{ Params: { id: string; elementId: string } }>(
    '/api/v1/productions/:id/audio/:elementId/processing',
    async (req, reply) => {
      const body = AudioProcPatch.parse(req.body);
      const elementId = req.params.elementId;
      const isMain = elementId === 'main';
      const ch = isMain ? null : chNum(elementId);
      if (!isMain && ch === null) {
        return reply.status(400).send({ error: 'Invalid channel id', statusCode: 400 });
      }
      const stage = body.stage as AudioProcStage;
      if (!stageAllowedOnElement(stage, elementId)) {
        return reply.status(400).send({ error: `Stage '${stage}' is not valid on '${elementId}'`, statusCode: 400 });
      }
      const parsed = parseStageParams(stage, body.params);
      if (!parsed.ok) {
        return reply.status(400).send({ error: parsed.error, statusCode: 400 });
      }
      const params = parsed.params;
      try {
        const doc = await getDb().get(req.params.id);
        // Persist regardless of activation so the setting applies on next
        // activation and survives deactivate/reactivate.
        const nextStore = mergeIntoStore(doc.audioProcessing, elementId, stage, params);
        await updateProductionDoc(req.params.id, { audioProcessing: nextStore });

        const { live } = stageToStromProps(elementId, stage, params);
        let applied = false;
        if (doc.stromFlowId && Object.keys(live).length > 0) {
          const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
          const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
          const { flow } = await withTimeout(strom.flows.get(doc.stromFlowId), 5000);
          const mixerBlock = (flow.blocks ?? []).find((b) => b.block_definition_id === MIXER_BLOCK_TYPE);
          if (!mixerBlock) return reply.status(404).send({ error: 'Mixer block not found', statusCode: 404 });
          try {
            await withTimeout(strom.flows.updateBlockProperties(doc.stromFlowId, mixerBlock.id, { properties: live }), 5000);
            applied = true;
          } catch (werr) {
            if (werr instanceof StromPropertiesRejectedError) {
              return reply.status(422).send({ error: werr.message, statusCode: 422 });
            }
            throw werr;
          }
        }
        // Same AUDIO_PROC_STATE shape the WS path broadcasts; applied:true only
        // when the live write reached Strom.
        broadcast(req.params.id, { type: 'AUDIO_PROC_STATE', elementId, stage, params, ...(applied ? { applied: true } : {}) });
        return reply.send({ element_id: elementId, stage, params, applied });
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
