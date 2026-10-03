import type { StromClient } from './strom.js';

/**
 * Low-latency ("fast") return feeds — `returnFeed.lowLatency`
 * (`docs/specs/guest-calling-intercom.md` §"Low-latency mode").
 *
 * A picture feed's audio is held to the program flow's latency plus the WHIP
 * jitterbuffer, because Strom runs every sink in a flow at one latency. The fast
 * feed therefore lives in a second Strom flow (the conversation flow) with its own
 * latency:
 *
 *   program flow:      <audio mixer>:direct_out_N → builtin.audio_bridge_output
 *   conversation flow: builtin.audio_bridge_input → builtin.liveaudiorouter
 *                      → builtin.whep_output (audio only), one per fast return
 *
 * A mixer direct out carries what its channel sends to Main: after the fader,
 * the mute and `ch{N}_to_main`, before the Main sum. The crew's changes
 * therefore reach the fast feed inside Strom, and the router is a fixed
 * mix-minus that open-live never writes after activation.
 *
 * The bridge restamps on arrival and time-stretches to hold a small target
 * latency, so a publisher's jitterbuffer does not add to the fast feed. The
 * router sums every channel except the guest's own (mix-minus). Nothing here
 * feeds program output or a recording: time-stretched audio never airs.
 *
 * A direct out's consumer that ends or is torn down while program runs stops
 * that channel on program, without an error (Eyevinn/strom#930). The bridge
 * outputs are therefore part of the program flow from its creation and go
 * away only with it; nothing edits them in a running flow.
 */

/** Router settings verified with five simultaneous WHIP seats (latency / min upstream / output buffer, ms). */
export const FAST_ROUTER_LATENCY_MS = 15;
export const FAST_ROUTER_MIN_UPSTREAM_LATENCY_MS = 10;
export const FAST_ROUTER_OUTPUT_BUFFER_MS = 5;
/** Most inputs, and most outputs, a `builtin.liveaudiorouter` builds (Strom's `MAX_STREAMS`). */
export const FAST_ROUTER_MAX_STREAMS = 8;

type Block = Record<string, unknown>;
type Link = { from: string; to: string };

export interface FastReturnRequest {
  mixerInput: string;
  /** N of the guest's `video_in_N` — names the endpoint like the picture feed. */
  padIndex: number;
  /** Guest's own 0-based audio channel, left out of their fast feed. */
  ownChannel: number;
}

export interface FastReturnPlan {
  /**
   * Blocks and links to add to the program flow (one bridge output per channel).
   * The audio mixer must also be built with `direct_outs: true`.
   */
  programBlocks: Block[];
  programLinks: Link[];
  /** The conversation flow's topology. */
  conversation: { blocks: Block[]; elements: Block[]; links: Link[] };
  /** Fast WHEP endpoint per guest. */
  entries: Array<{ mixerInput: string; endpointId: string }>;
  /** The router block id; the flow id is known once the flow is created. */
  routerBlockId: string;
}

/**
 * Plans the fast return feeds for a production.
 *
 * @param suffix          per-production suffix (keeps bridge channels and endpoints unique across productions)
 * @param mixerBlockId    the program flow's `builtin.mixer` block
 * @param numChannels     audio channels on that mixer
 * @param returns         guests that get a fast feed
 * @param targetLatencyMs bridge target latency; Strom's default when undefined
 */
export function planFastReturns(
  suffix: string,
  mixerBlockId: string,
  numChannels: number,
  returns: readonly FastReturnRequest[],
  targetLatencyMs?: number,
): FastReturnPlan | null {
  if (returns.length === 0 || numChannels <= 0) return null;
  const programBlocks: Block[] = [];
  const programLinks: Link[] = [];
  const blocks: Block[] = [];
  const elements: Block[] = [];
  const links: Link[] = [];
  const routerId = `b-fast-router-${suffix}`;

  for (let ch = 0; ch < numChannels; ch++) {
    const channel = `fast-${suffix}-${ch}`;
    const outId = `b-fast-bridge-out-${ch}-${suffix}`;
    const inId = `b-fast-bridge-in-${ch}-${suffix}`;
    programBlocks.push({
      id: outId,
      block_definition_id: 'builtin.audio_bridge_output',
      name: `Fast feed bridge ch${ch + 1}`,
      properties: { channel },
      position: { x: 0, y: 0 },
    });
    // Mixer pads are 1-based: channel 0 is `input_1` and `direct_out_1`.
    programLinks.push({ from: `${mixerBlockId}:direct_out_${ch + 1}`, to: `${outId}:audio_in` });
    blocks.push({
      id: inId,
      block_definition_id: 'builtin.audio_bridge_input',
      name: `Bridge ch${ch + 1}`,
      properties: { channel, ...(targetLatencyMs !== undefined ? { target_latency_ms: targetLatencyMs } : {}) },
      position: { x: 0, y: ch * 150 },
    });
    // The router's buses pick their own format; the bridge carries F32LE 48 kHz.
    const convId = `e-fast-conv-${ch}-${suffix}`;
    const resId = `e-fast-res-${ch}-${suffix}`;
    elements.push(
      { id: convId, element_type: 'audioconvert', properties: {}, position: [250, ch * 150] },
      { id: resId, element_type: 'audioresample', properties: {}, position: [400, ch * 150] },
    );
    links.push(
      { from: `${inId}:audio_out`, to: `${convId}:sink` },
      { from: `${convId}:src`, to: `${resId}:sink` },
      { from: `${resId}:src`, to: `${routerId}:audio_in_${ch}` },
    );
  }

  blocks.push({
    id: routerId,
    block_definition_id: 'builtin.liveaudiorouter',
    name: 'Fast feed router',
    properties: {
      num_inputs: numChannels,
      num_outputs: returns.length,
      latency: FAST_ROUTER_LATENCY_MS,
      min_upstream_latency: FAST_ROUTER_MIN_UPSTREAM_LATENCY_MS,
      output_buffer_duration: FAST_ROUTER_OUTPUT_BUFFER_MS,
      routing_matrix: fastRoutingMatrix(numChannels, returns.map((r) => r.ownChannel)),
    },
    position: { x: 600, y: 0 },
  });

  const entries: FastReturnPlan['entries'] = [];
  returns.forEach((r, out) => {
    const endpointId = `whep-fast-${r.padIndex}-${suffix}`;
    const whepId = `b-fast-${r.padIndex}-${suffix}`;
    blocks.push({
      id: whepId,
      block_definition_id: 'builtin.whep_output',
      name: `Fast return (${r.mixerInput})`,
      properties: { endpoint_id: endpointId, low_latency: true, num_audio_tracks: 1, num_video_tracks: 0 },
      position: { x: 900, y: out * 150 },
    });
    links.push({ from: `${routerId}:audio_out_${out}`, to: `${whepId}:audio_in` });
    entries.push({ mixerInput: r.mixerInput, endpointId });
  });

  return {
    programBlocks,
    programLinks,
    conversation: { blocks, elements, links },
    entries,
    routerBlockId: routerId,
  };
}

/**
 * The router's `routing_matrix`: output N sums every channel at unity except
 * `ownChannels[N]`. Crosspoint keys are `i<input>c<channel>` → `o<output>c<channel>`,
 * stereo. The crew's fader, mute and to-Main are already applied upstream, in the
 * mixer's direct outs, so the matrix never changes while the flow runs.
 *
 * @param numInputs   audio channels on the router
 * @param ownChannels 0-based own channel per router output
 */
export function fastRoutingMatrix(numInputs: number, ownChannels: readonly number[]): string {
  const matrix: Record<string, string[]> = {};
  ownChannels.forEach((own, out) => {
    for (let ch = 0; ch < numInputs; ch++) {
      if (ch === own) continue;
      for (const c of [0, 1]) (matrix[`i${ch}c${c}`] ??= []).push(`o${out}c${c}`);
    }
  });
  return JSON.stringify(matrix);
}

/** Where a running fast-feed router lives, persisted as `ProductionDoc.fastFeedRouter`. */
export interface FastFeedRouter {
  /** Conversation flow id. */
  flowId: string;
  /** The `builtin.liveaudiorouter` block id in that flow. */
  blockId: string;
}

/** `properties.description` of a production's conversation flow; ties it to the program flow. */
export function conversationFlowDescription(programFlowId: string): string {
  return `conv:${programFlowId}`;
}

/** Program flow id a conversation flow belongs to, or null for any other flow. */
export function conversationFlowOwner(description: string | undefined): string | null {
  const m = /^conv:(.+)$/.exec(description ?? '');
  return m ? m[1]! : null;
}

/**
 * Stops and deletes every conversation flow whose program flow is not among
 * `flows` (Strom's current flow list). Returns the ids it removed.
 */
export async function removeOrphanConversationFlows(
  strom: Pick<StromClient, 'flows'>,
  flows: ReadonlyArray<{ id: string; properties?: unknown }>,
): Promise<string[]> {
  const live = new Set(flows.map((f) => f.id));
  const removed: string[] = [];
  for (const f of flows) {
    const owner = conversationFlowOwner((f.properties as { description?: string } | undefined)?.description);
    if (!owner || live.has(owner)) continue;
    await strom.flows.stop(f.id).catch(() => undefined);
    await strom.flows.delete(f.id).catch(() => undefined);
    removed.push(f.id);
  }
  return removed;
}
