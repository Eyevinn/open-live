import { randomUUID } from 'crypto';
import type { ProductionDoc, SourceDoc, GraphicDoc, OutputDoc } from '../db/types.js';
import { getSourcesDb, getGraphicsDb } from '../db/index.js';
import { StromClient } from './strom.js';
import { DEFAULT_FLOW, type FlowTopology } from './default-flow.js';
import { decryptAddressPassphrase } from './srt-passphrase-crypto.js';
import { safeFlowProjection } from './log-redact.js';

/**
 * Generates a Strom flow from a template + source assignments,
 * creates it in Strom, starts it, and returns the flow ID.
 *
 * Throws if no templateId is set, template is not found,
 * or Strom creation/start fails.
 */
export interface ActivationResult {
  flowId: string;
  mixerBlockId: string | null;
  audioMixerBlockId: string | null;
  /** ID of the builtin.loudness block inserted after the audio mixer main_out — used by meter relay */
  loudnessMainBlockId: string | null;
  whepOutputEntries?: Array<{ outputId: string; endpointId: string }>;
  pgmWhepEndpointId?: string;
  /** WHEP endpoint ID for the mixer's monitor_out (headphone/monitor bus) — undefined if no audio mixer */
  monitorWhepEndpointId?: string;
  /** Maps mixerInput (e.g. 'video_in_1') → time_offset block ID — so the WS layer can apply live offset changes */
  sourceOffsetBlockIds: Record<string, string>;
  /** Maps mixerInput → audio time_offset block ID (one per source with audio, keyed same as sourceOffsetBlockIds) */
  sourceAudioOffsetBlockIds: Record<string, string>;
}

function findPgmFeedPad(flow: FlowTopology): string | null {
  const existingOutput = flow.blocks.find(
    (b) => (b as Record<string, unknown>)['block_definition_id'] === 'builtin.mpegtssrt_output',
  ) as Record<string, unknown> | undefined;
  if (existingOutput) {
    const outputId = existingOutput['id'] as string;
    const feedLink = flow.links.find((link) => {
      const l = link as Record<string, unknown>;
      return ((l['to'] as string | undefined) ?? '').startsWith(`${outputId}:`);
    }) as Record<string, unknown> | undefined;
    if (feedLink) return feedLink['from'] as string;
  }
  const encPgm = flow.blocks.find(
    (b) =>
      (b as Record<string, unknown>)['block_definition_id'] === 'builtin.videoenc' &&
      (b as Record<string, unknown>)['name'] === 'Enc PGM',
  ) as Record<string, unknown> | undefined;
  if (encPgm) return `${encPgm['id'] as string}:video_out`;
  return null;
}

export async function activateStromFlow(
  production: ProductionDoc,
  strom: StromClient,
  stromUrl?: string,
  outputDocs?: OutputDoc[],
): Promise<ActivationResult> {
  // Virtual source IDs for test streams — no DB lookup needed
  const VIRTUAL_SOURCES: Record<string, Pick<SourceDoc, 'streamType' | 'address' | 'name'>> = {
    'Whip': { streamType: 'whip', address: '', name: 'WHIP Input' },
    '__test1__': { streamType: 'test1', address: '', name: 'Test - Pinwheel' },
    '__test2__': { streamType: 'test2', address: '', name: 'Test - Colors' },
  };

  // Load all assigned real sources — skip any whose source doc no longer exists
  // (e.g. source was deleted while assigned to this production).
  const sourcesDb = getSourcesDb();
  const sourceMap = new Map<string, SourceDoc>();
  for (const assignment of production.sources) {
    if (assignment.sourceId in VIRTUAL_SOURCES) continue;
    try {
      const src = await sourcesDb.get(assignment.sourceId) as unknown as SourceDoc;
      // Decrypt the at-rest SRT passphrase so Strom receives a usable srt_uri.
      // Legacy plaintext addresses pass through unchanged (issue #160).
      src.address = decryptAddressPassphrase(src.address);
      sourceMap.set(assignment.sourceId, src);
    } catch {
      console.warn(`[flow-generator] Source ${assignment.sourceId} (${assignment.mixerInput}) not found — skipping`);
    }
  }

  // Deep-clone the default flow so we don't mutate the module-level constant
  const flow = JSON.parse(JSON.stringify(DEFAULT_FLOW)) as FlowTopology;

  // Derive a per-production suffix from the production ID so that WHEP endpoint
  // names and SRT output ports are unique — multiple productions can run
  // simultaneously without conflicting on shared resources.
  const endpointSuffix = production._id.replace(/^prod-/, '').slice(0, 8);

  // Remap all template block/element IDs to fresh random values so that two
  // productions running concurrently don't share element names in Strom's
  // global GStreamer pipeline context, which requires unique element names.
  {
    const idMap = new Map<string, string>();
    for (const b of flow.blocks) {
      const old = (b as Record<string, unknown>)['id'] as string | undefined;
      if (old) { const n = randomUUID().replace(/-/g, ''); idMap.set(old, n); (b as Record<string, unknown>)['id'] = n; }
    }
    for (const e of flow.elements) {
      const old = (e as Record<string, unknown>)['id'] as string | undefined;
      if (old) { const n = randomUUID().replace(/-/g, ''); idMap.set(old, n); (e as Record<string, unknown>)['id'] = n; }
    }
    // Patch links: "blockId:pad" → "newId:pad"
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      for (const side of ['from', 'to'] as const) {
        const val = l[side] as string | undefined;
        if (!val) continue;
        const colonIdx = val.indexOf(':');
        const blockId = colonIdx >= 0 ? val.slice(0, colonIdx) : val;
        const pad = colonIdx >= 0 ? val.slice(colonIdx) : '';
        const mapped = idMap.get(blockId);
        if (mapped) l[side] = mapped + pad;
      }
    }
  }

  // Resolve pgm_resolution: production.values takes precedence over the template
  // mixer block's default — avoids in-mixer upscaling on static inputs (test
  // sources) which causes QoS/videoconvert falling-behind events.
  const pgmResolution = (() => {
    if (typeof production.values?.pgm_resolution === 'string') return production.values.pgm_resolution;
    const mixer = flow.blocks.find(
      (b) => (b as Record<string, unknown>)['block_definition_id'] === 'builtin.vision_mixer',
    ) as Record<string, unknown> | undefined;
    const p = (mixer?.['properties'] ?? {}) as Record<string, unknown>;
    return typeof p['pgm_resolution'] === 'string' ? p['pgm_resolution'] : '1280x720';
  })();

  const pgmBitrate = typeof production.values?.bitrate === 'number' ? production.values.bitrate : undefined;
  const multiviewBitrate = typeof production.values?.multiview_bitrate === 'number' ? production.values.multiview_bitrate : undefined;
  const pgmFramerate = typeof production.values?.pgm_framerate === 'string' ? production.values.pgm_framerate : undefined;
  const multiviewResolution = typeof production.values?.multiview_resolution === 'string' ? production.values.multiview_resolution : undefined;
  const multiviewFramerate = typeof production.values?.multiview_framerate === 'string' ? production.values.multiview_framerate : undefined;
  const numAuxBuses = (() => {
    const v = production.values?.num_aux_buses;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const n = parseInt(v, 10); return isNaN(n) ? undefined : n; }
    return undefined;
  })();
  const numGroups = (() => {
    const v = production.values?.num_groups;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const n = parseInt(v, 10); return isNaN(n) ? undefined : n; }
    return undefined;
  })();
  const mixLatency = (() => {
    const v = production.values?.mix_latency;
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
    if (typeof v === 'string') { const n = parseInt(v, 10); return isNaN(n) ? 100 : Math.max(0, n); }
    return 100;
  })();
  const clockType = typeof production.values?.clock === 'string' && production.values.clock !== '' ? production.values.clock : undefined;

  for (const block of flow.blocks) {
    const b = block as Record<string, unknown>;
    const props = (b['properties'] ?? {}) as Record<string, unknown>;

    if (b['block_definition_id'] === 'builtin.vision_mixer') {
      props['pgm_resolution'] = pgmResolution;
      // num_inputs and input labels are set after source assignment is known (see below).
      if (pgmFramerate !== undefined) props['pgm_framerate'] = pgmFramerate;
      if (multiviewResolution !== undefined) props['multiview_resolution'] = multiviewResolution;
      if (multiviewFramerate !== undefined) props['multiview_framerate'] = multiviewFramerate;
      // swap_pvw_pgm (PR #637): non-live property — only applied at pipeline build time.
      const swapPvwPgm = production.values?.swap_pvw_pgm === true || production.values?.swap_pvw_pgm === 'true';
      if (swapPvwPgm) props['swap_pvw_pgm'] = true;
      b['properties'] = props;
    }

    if (b['block_definition_id'] === 'builtin.videoformat') {
      props['resolution'] = pgmResolution;
      b['properties'] = props;
    }

    if (b['block_definition_id'] === 'builtin.videoenc') {
      const name = b['name'] as string | undefined;
      if (name === 'Enc PGM' && pgmBitrate !== undefined) {
        props['bitrate'] = pgmBitrate;
        b['properties'] = props;
      }
      if (name === 'Enc MV' && multiviewBitrate !== undefined) {
        props['bitrate'] = multiviewBitrate;
        b['properties'] = props;
      }
    }

    if (b['block_definition_id'] === 'builtin.mixer') {
      if (numAuxBuses !== undefined) props['num_aux_buses'] = numAuxBuses;
      if (numGroups !== undefined) props['num_groups'] = numGroups;
      b['properties'] = props;
    }

    // Uniquify WHEP endpoint_ids per production so concurrent productions don't
    // collide on the same WHEP stream name.
    if (b['block_definition_id'] === 'builtin.whep_output') {
      if (typeof props['endpoint_id'] === 'string') {
        props['endpoint_id'] = `${props['endpoint_id']}-${endpointSuffix}`;
      }
      b['properties'] = props;
    }
  }

  // Extract the PGM WHEP endpoint_id (now uniquified to 'pgm-{suffix}') so the
  // activation route can construct the full WHEP URL for the production doc.
  let pgmWhepEndpointId: string | undefined;
  for (const block of flow.blocks) {
    const b = block as Record<string, unknown>;
    if (
      b['block_definition_id'] === 'builtin.whep_output' &&
      (b['name'] as string | undefined) === 'PGM Output'
    ) {
      const props = (b['properties'] ?? {}) as Record<string, unknown>;
      if (typeof props['endpoint_id'] === 'string') pgmWhepEndpointId = props['endpoint_id'];
      break;
    }
  }

  // Find the PGM feed pad before stripping program output blocks.
  // builtin.whep_output is intentionally kept — it carries the multiview stream
  // that the controller's WHEP viewer connects to via /blocks/{id}/multiview-endpoint.
  const pgmFeedPad = findPgmFeedPad(flow);

  // Strip only SRT/EFP program output blocks from the template.
  // User-assigned outputs are injected below; the template's WHEP block stays.
  const OUTPUT_BLOCK_DEFS = new Set([
    'builtin.mpegtssrt_output',
    'builtin.efpsrt_output',
  ]);
  const strippedOutputIds = new Set<string>(
    (flow.blocks as Record<string, unknown>[])
      .filter((b) => OUTPUT_BLOCK_DEFS.has(b['block_definition_id'] as string))
      .map((b) => b['id'] as string),
  );
  flow.blocks = flow.blocks.filter((b) => !strippedOutputIds.has((b as Record<string, unknown>)['id'] as string));
  flow.links = flow.links.filter((link) => {
    const l = link as Record<string, unknown>;
    const fromId = ((l['from'] as string | undefined) ?? '').split(':')[0];
    const toId = ((l['to'] as string | undefined) ?? '').split(':')[0];
    return !strippedOutputIds.has(fromId) && !strippedOutputIds.has(toId);
  });

  // Find the vision mixer block
  const mixerBlock = flow.blocks.find(
    (b) => (b as Record<string, unknown>)['block_definition_id'] === 'builtin.vision_mixer',
  ) as Record<string, unknown> | undefined;
  const mixerBlockId = typeof mixerBlock?.['id'] === 'string' ? mixerBlock['id'] : null;

  // Find the audio mixer block (may not exist in older templates)
  const audioMixerBlock = flow.blocks.find(
    (b) => (b as Record<string, unknown>)['block_definition_id'] === 'builtin.mixer',
  ) as Record<string, unknown> | undefined;
  const audioMixerBlockId = typeof audioMixerBlock?.['id'] === 'string' ? audioMixerBlock['id'] : null;

  // Inject a builtin.loudness block as a parallel tap on the audio mixer main_out.
  // The loudness block is NOT in series — main audio flows directly to all consumers.
  // loudness:audio_out drains into a raw fakesink element so Strom doesn't stall.
  // The block is pushed to flow.blocks after the output loop so its y position
  // lands below the output/encoder blocks in the same Strom GUI column.
  let loudnessMainBlockId: string | null = null;
  const ebuMainEnabled = production.values?.ebu_main === true;
  if (audioMixerBlockId && ebuMainEnabled) {
    loudnessMainBlockId = `b-loudness-main-${endpointSuffix}`;
  }
  // Main audio goes directly from the mixer — loudness is a side tap, not in the chain.
  const mainAudioSource = audioMixerBlockId ? `${audioMixerBlockId}:main_out` : null;

  // Wire all template WHEP outputs:
  //   audio_in   (track 0) ← main programme mix
  //   audio_in_1 (track 1) ← monitor_out (headphone/monitor bus) when audio mixer present
  // num_audio_tracks=2 creates the second audio input pad on the WHEP output block.
  const monitorAudioSource = audioMixerBlockId ? `${audioMixerBlockId}:monitor_out` : null;
  for (const block of flow.blocks) {
    const b = block as Record<string, unknown>;
    if (b['block_definition_id'] !== 'builtin.whep_output') continue;
    const whepId = b['id'] as string;
    const props = ((b['properties'] ?? {}) as Record<string, unknown>);
    // Remove any existing audio links to this block — we rebuild them below.
    flow.links = (flow.links as Array<Record<string, unknown>>).filter(
      (l) => !((l['to'] as string | undefined) ?? '').startsWith(`${whepId}:audio`),
    );
    if (mainAudioSource) {
      const auxCount = numAuxBuses ?? 0;
      props['num_audio_tracks'] = 1 + (monitorAudioSource ? 1 : 0) + auxCount;
      b['properties'] = props;
      flow.links.push({ from: mainAudioSource, to: `${whepId}:audio_in` });
      let audioTrack = 1;
      if (monitorAudioSource) {
        flow.links.push({ from: monitorAudioSource, to: `${whepId}:audio_in_${audioTrack}` });
        audioTrack++;
      }
      for (let i = 1; i <= auxCount; i++) {
        if (audioMixerBlockId) {
          flow.links.push({ from: `${audioMixerBlockId}:aux_out_${i}`, to: `${whepId}:audio_in_${audioTrack}` });
          audioTrack++;
        }
      }
    }
  }

  // Strip ALL inputs wired to video_in_N pads on the mixer (dynamic blocks AND
  // static template placeholders like videotestsrc). We rebuild all video inputs
  // from production.sources, so the template's static elements must be removed.
  const DYNAMIC_INPUT_BLOCK_DEFS = new Set(['builtin.mpegtssrt_input', 'builtin.efpsrt_input', 'builtin.whip_input']);
  const strippedVideoInputIds = new Set<string>();

  // Collect dynamic block IDs (mpegtssrt_input, whip_input)
  for (const block of flow.blocks) {
    const b = block as Record<string, unknown>;
    if (DYNAMIC_INPUT_BLOCK_DEFS.has(b['block_definition_id'] as string)) {
      strippedVideoInputIds.add(b['id'] as string);
    }
  }

  // Collect static elements/blocks directly wired to video_in_N (e.g. format blocks)
  if (mixerBlockId) {
    const videoInPattern = new RegExp(`^${mixerBlockId}:video_in_\\d+$`);
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      if (videoInPattern.test((l['to'] as string | undefined) ?? '')) {
        strippedVideoInputIds.add(((l['from'] as string | undefined) ?? '').split(':')[0]);
      }
    }
    // One more level back: strip raw elements wired INTO those format blocks
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      const toId = ((l['to'] as string | undefined) ?? '').split(':')[0];
      if (strippedVideoInputIds.has(toId)) {
        strippedVideoInputIds.add(((l['from'] as string | undefined) ?? '').split(':')[0]);
      }
    }
  }

  flow.blocks = flow.blocks.filter((b) => !strippedVideoInputIds.has((b as Record<string, unknown>)['id'] as string));
  flow.elements = flow.elements.filter((el) => !strippedVideoInputIds.has((el as Record<string, unknown>)['id'] as string));
  flow.links = flow.links.filter((link) => {
    const l = link as Record<string, unknown>;
    const fromId = ((l['from'] as string | undefined) ?? '').split(':')[0];
    const toId = ((l['to'] as string | undefined) ?? '').split(':')[0];
    return !strippedVideoInputIds.has(fromId) && !strippedVideoInputIds.has(toId);
  });

  // Dynamically generate input blocks based on each source's streamType and wire
  // them to the correct mixer pad.
  const sortedAssignments = [...production.sources].sort((a, b) =>
    a.mixerInput.localeCompare(b.mixerInput),
  );

  // Set num_inputs on the vision mixer based solely on the number of dynamic sources.
  // All static template video inputs are stripped above, so no static pad count needed.
  // Allowed values: 2, 4, 6, 8, 10 (non-live property — must be set at creation).
  // Also set input_{N}_label for each assigned source so Strom renders the name
  // in the multiview overlay (verified: property format from strom/backend/src/blocks/builtin/vision_mixer/properties.rs).
  const numSourceInputs = Math.max(2, sortedAssignments.length);

  if (mixerBlock && mixerBlockId) {
    // num_inputs = real sources only, rounded up to Strom's allowed range (2..16).
    // PiPs are a separate first-class concept in Strom 0.5+ — set via num_pips, NOT
    // by expanding num_inputs. max num_inputs is 16 per Strom's MAX_NUM_INPUTS constant.
    const numTotalInputs = Math.max(2, Math.min(16, numSourceInputs));
    const props = (mixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['num_inputs'] = String(numTotalInputs);

    // num_pips: 0–4 (Strom MAX_NUM_PIPS = 4, DEFAULT_NUM_PIPS = 0).
    // Taken directly from production config — validated against the max at runtime by Strom.
    const configuredPips = Number(production.values?.num_pips ?? 0);
    props['num_pips'] = String(Math.min(4, Math.max(0, configuredPips)));

    // Label source inputs
    for (const assignment of sortedAssignments) {
      const padMatch = /video_in_(\d+)$/.exec(assignment.mixerInput);
      if (!padMatch) continue;
      const padIndex = parseInt(padMatch[1], 10);
      const src = sourceMap.get(assignment.sourceId) ?? (VIRTUAL_SOURCES[assignment.sourceId] as SourceDoc | undefined);
      if (src?.name) {
        props[`input_${padIndex}_label`] = src.name;
      }
    }

    mixerBlock['properties'] = props;
  }

  // Set num_channels on the audio mixer = number of audio-bearing sources.
  // test1/test2 sources get a silent audiotestsrc below, so they count here too.
  // num_channels is a UInt — set it to exactly the number of audio-bearing sources.
  if (audioMixerBlock) {
    const audioSourceCount = sortedAssignments.filter((a) => {
      const src = sourceMap.get(a.sourceId) ?? (VIRTUAL_SOURCES[a.sourceId] as SourceDoc | undefined);
      return src != null;
    }).length;
    const numChannels = Math.max(1, audioSourceCount);
    const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['num_channels'] = numChannels;
    // ch{N}_aux{M}_pre is a build-time topology property — must be set here at flow
    // generation time; attempts to change it on a running pipeline are rejected by Strom.
    // Per-bus setting: aux1_pre, aux2_pre, … (boolean, default true = pre-fader).
    // Falls back to the legacy aux_pre_fader key for older productions.
    if (typeof numAuxBuses === 'number' && numAuxBuses > 0) {
      const legacyPre = production.values?.aux_pre_fader;
      for (let aux = 1; aux <= numAuxBuses; aux++) {
        const perBusKey = `aux${aux}_pre`;
        const perBusValue = production.values?.[perBusKey];
        const isPre = typeof perBusValue === 'boolean' ? perBusValue
          : typeof legacyPre === 'boolean' ? legacyPre
          : true; // default pre-fader
        for (let ch = 1; ch <= numChannels; ch++) {
          props[`ch${ch}_aux${aux}_pre`] = isPre;
        }
      }
    }
    audioMixerBlock['properties'] = props;
  }

  // Compute the highest latency across all SRT/EFP sources. Each source keeps its
  // own configured latency; the max is used only to set min_upstream_latency on the
  // mixers so the aggregators never starve waiting for the slowest source.
  const srtLatencies = sortedAssignments
    .map((a) => sourceMap.get(a.sourceId) ?? (VIRTUAL_SOURCES[a.sourceId] as SourceDoc | undefined))
    .filter((s): s is SourceDoc => !!s && s.streamType !== 'test1' && s.streamType !== 'test2' && s.streamType !== 'whip' && s.streamType !== 'html')
    .map((s) => s.latency ?? 125);
  const maxSourceLatency = srtLatencies.length > 0 ? Math.max(...srtLatencies) : 125;

  if (mixerBlock) {
    const props = (mixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['latency'] = mixLatency;
    props['min_upstream_latency'] = maxSourceLatency;
    mixerBlock['properties'] = props;
  }
  if (audioMixerBlock) {
    const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['latency'] = mixLatency;
    props['min_upstream_latency'] = maxSourceLatency;
    audioMixerBlock['properties'] = props;
  }

  let audioChannelIndex = 0;
  const ROW_H = 150;        // vertical spacing between rows
  const ROW_START = 50;     // y of first input row
  const COL_ELEM = -500;    // col 1: cefsrc / videotestsrc elements
  const COL_INPUT = -250;   // col 2: input blocks (mpegtssrt_input, whip_input, videoformat)
  const COL_OFFSET = 0;     // col 3: time_offset blocks (between source and mixer)
  const COL_OUTPUT = 850;   // col 5: output blocks

  // Maps mixerInput → time_offset block ID — returned so the WS layer can apply live changes.
  const sourceOffsetBlockIds: Record<string, string> = {};
  const sourceAudioOffsetBlockIds: Record<string, string> = {};

  for (const assignment of sortedAssignments) {
    const padMatch = /video_in_(\d+)$/.exec(assignment.mixerInput);
    if (!padMatch || !mixerBlockId) continue;
    const padIndex = parseInt(padMatch[1], 10);

    const source = sourceMap.get(assignment.sourceId) ?? (VIRTUAL_SOURCES[assignment.sourceId] as SourceDoc | undefined);
    if (!source) continue;

    const yPos = ROW_START + padIndex * ROW_H;
    const inputId = `b-input-${padIndex}-${endpointSuffix}`;

    // Insert a time_offset block between this source and the vision mixer.
    // Starts at 0 ms; operators adjust it live via SOURCE_OFFSET_SET WS messages.
    const offsetId = `b-offset-${padIndex}-${endpointSuffix}`;
    flow.blocks.push({
      id: offsetId,
      block_definition_id: 'builtin.time_offset',
      name: `Offset V${padIndex}`,
      properties: { offset_ms: 0.0 },
      position: { x: COL_OFFSET, y: yPos },
    });
    sourceOffsetBlockIds[assignment.mixerInput] = offsetId;
    // Final link: offset → mixer (applies to all source types below)
    flow.links.push({ from: `${offsetId}:out`, to: `${mixerBlockId}:${assignment.mixerInput}` });

    const TEST_PATTERNS: Record<string, string> = { test1: 'Pinwheel', test2: 'Colors' }
    if (source.streamType === 'test1' || source.streamType === 'test2') {
      const audioChannel = audioChannelIndex++;
      const elemId = `e-test-${padIndex}-${endpointSuffix}`;
      const fmtId = `b-fmt-${padIndex}-${endpointSuffix}`;
      const audioElemId = `e-test-audio-${padIndex}-${endpointSuffix}`;
      const audioOffsetId = `b-audio-offset-${padIndex}-${endpointSuffix}`;
      flow.elements.push({
        id: elemId,
        element_type: 'videotestsrc',
        properties: { pattern: TEST_PATTERNS[source.streamType] },
        position: [COL_ELEM, yPos],
      });
      flow.blocks.push({
        id: fmtId,
        block_definition_id: 'builtin.videoformat',
        name: `Format V${padIndex}`,
        properties: { resolution: '1920x1080' },
        position: { x: COL_INPUT, y: yPos },
      });
      flow.links.push(
        { from: `${elemId}:src`, to: `${fmtId}:video_in` },
        { from: `${fmtId}:video_out`, to: `${offsetId}:in` },
      );
      // Add a silent audio branch so every test pattern has a linked audio producer.
      // Without this, the audio mixer ends up with channels that have no source,
      // causing the aggregator to stall waiting for buffers that never arrive.
      flow.elements.push({
        id: audioElemId,
        element_type: 'audiotestsrc',
        properties: { wave: 'silence', 'is-live': true },
        position: [COL_ELEM, yPos - 80],
      });
      flow.blocks.push({
        id: audioOffsetId,
        block_definition_id: 'builtin.time_offset',
        name: `Offset A${padIndex}`,
        properties: { offset_ms: 0.0 },
        position: { x: COL_OFFSET, y: yPos - 80 },
      });
      sourceAudioOffsetBlockIds[assignment.mixerInput] = audioOffsetId;
      flow.links.push({ from: `${audioElemId}:src`, to: `${audioOffsetId}:in` });
      flow.links.push({ from: `${audioOffsetId}:out`, to: `${mixerBlockId}:audio_in_${padIndex}` });
      if (audioMixerBlock && audioMixerBlockId) {
        flow.links.push({ from: `${audioOffsetId}:out`, to: `${audioMixerBlockId}:input_${audioChannel + 1}` });
        if (source.name) {
          const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
          props[`ch${audioChannel + 1}_label`] = source.name;
          audioMixerBlock['properties'] = props;
        }
      }
    } else if (source.streamType === 'html') {
      const audioChannel = audioChannelIndex++;
      const elemId = `e-html-${padIndex}-${endpointSuffix}`;
      const demuxId = `e-cefdemux-${padIndex}-${endpointSuffix}`;
      flow.elements.push({
        id: elemId,
        element_type: 'cefsrc',
        properties: { url: source.address },
        position: [COL_ELEM, yPos],
      });
      flow.elements.push({
        id: demuxId,
        element_type: 'cefdemux',
        properties: {},
        position: [COL_INPUT, yPos],
      });
      // cefsrc:src → cefdemux:sink; cefdemux splits into video and audio pads.
      // Skipping builtin.videoformat avoids autovideoconvert trying to use GL,
      // which conflicts with cefsrc's X11/Xvfb rendering context on GPU hosts.
      flow.links.push({ from: `${elemId}:src`, to: `${demuxId}:sink` });
      flow.links.push({ from: `${demuxId}:video`, to: `${offsetId}:in` });
      const audioOffsetId = `b-audio-offset-${padIndex}-${endpointSuffix}`;
      flow.blocks.push({
        id: audioOffsetId,
        block_definition_id: 'builtin.time_offset',
        name: `Offset A${padIndex}`,
        properties: { offset_ms: 0.0 },
        position: { x: COL_OFFSET, y: yPos - 80 },
      });
      sourceAudioOffsetBlockIds[assignment.mixerInput] = audioOffsetId;
      flow.links.push({ from: `${demuxId}:audio`, to: `${audioOffsetId}:in` });
      // Audio to vision mixer and audio mixer both come from the delay block.
      flow.links.push({ from: `${audioOffsetId}:out`, to: `${mixerBlockId}:audio_in_${padIndex}` });
      if (audioMixerBlock && audioMixerBlockId) {
        flow.links.push({ from: `${audioOffsetId}:out`, to: `${audioMixerBlockId}:input_${audioChannel + 1}` });
        if (source.name) {
          const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
          props[`ch${audioChannel + 1}_label`] = source.name;
          audioMixerBlock['properties'] = props;
        }
      }
    } else if (source.streamType === 'whip') {
      const audioChannel = audioChannelIndex++;
      const endpointId = `whip-${padIndex}-${endpointSuffix}`;
      flow.blocks.push({
        id: inputId,
        block_definition_id: 'builtin.whip_input',
        name: `WHIP Input (V${padIndex})`,
        properties: { endpoint_id: endpointId },
        position: { x: COL_INPUT, y: yPos },
      });
      flow.links.push({ from: `${inputId}:video_out`, to: `${offsetId}:in` });
      const audioOffsetIdWhip = `b-audio-offset-${padIndex}-${endpointSuffix}`;
      flow.blocks.push({
        id: audioOffsetIdWhip,
        block_definition_id: 'builtin.time_offset',
        name: `Offset A${padIndex}`,
        properties: { offset_ms: 0.0 },
        position: { x: COL_OFFSET, y: yPos + 80 },
      });
      sourceAudioOffsetBlockIds[assignment.mixerInput] = audioOffsetIdWhip;
      flow.links.push({ from: `${inputId}:audio_out`, to: `${audioOffsetIdWhip}:in` });
      flow.links.push({ from: `${audioOffsetIdWhip}:out`, to: `${mixerBlockId}:audio_in_${padIndex}` });
      if (audioMixerBlock && audioMixerBlockId) {
        flow.links.push({ from: `${audioOffsetIdWhip}:out`, to: `${audioMixerBlockId}:input_${audioChannel + 1}` });
        if (source.name) {
          const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
          props[`ch${audioChannel + 1}_label`] = source.name;
          audioMixerBlock['properties'] = props;
        }
      }
    } else {
      // srt → builtin.mpegtssrt_input, efp → builtin.efpsrt_input
      const audioChannel = audioChannelIndex++;
      flow.blocks.push({
        id: inputId,
        block_definition_id: source.streamType === 'efp' ? 'builtin.efpsrt_input' : 'builtin.mpegtssrt_input',
        name: `${source.streamType === 'efp' ? 'EFP' : 'SRT'} Input (V${padIndex})`,
        properties: {
          srt_uri: source.address || 'srt://127.0.0.1:5005?mode=caller',
          latency: source.latency ?? 125,
        },
        position: { x: COL_INPUT, y: yPos },
      });
      flow.links.push({ from: `${inputId}:video_out`, to: `${offsetId}:in` });
      // Audio goes via the delay block to both vision mixer and audio mixer so
      // operators can trim lipsync and vision mixer audio stays in sync.
      const audioOffsetId = `b-audio-offset-${padIndex}-${endpointSuffix}`;
      flow.blocks.push({
        id: audioOffsetId,
        block_definition_id: 'builtin.time_offset',
        name: `Offset A${padIndex}`,
        properties: { offset_ms: 0.0 },
        position: { x: COL_OFFSET, y: yPos + 80 },
      });
      sourceAudioOffsetBlockIds[assignment.mixerInput] = audioOffsetId;
      flow.links.push({ from: `${inputId}:audio_out_0`, to: `${audioOffsetId}:in` });
      flow.links.push({ from: `${audioOffsetId}:out`, to: `${mixerBlockId}:audio_in_${padIndex}` });
      if (audioMixerBlock && audioMixerBlockId) {
        flow.links.push({ from: `${audioOffsetId}:out`, to: `${audioMixerBlockId}:input_${audioChannel + 1}` });
        if (source.name) {
          const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
          props[`ch${audioChannel + 1}_label`] = source.name;
          audioMixerBlock['properties'] = props;
        }
      }
    }
  }

  // Strip any cefsrc elements (and any intermediate videoformat blocks) from the template
  // that are wired to dsk_in_N pads. These are replaced by graphicAssignments at activation.
  if (mixerBlockId) {
    const dskLinkPattern = new RegExp(`^${mixerBlockId}:dsk_in_\\d+$`);
    const stripIds = new Set<string>();

    // First pass: collect IDs directly connected to dsk_in_N (may be videoformat blocks or cefsrc)
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      const to = (l['to'] as string | undefined) ?? '';
      if (dskLinkPattern.test(to)) {
        stripIds.add(((l['from'] as string | undefined) ?? '').split(':')[0]);
      }
    }

    // Second pass: follow one more hop back to catch cefsrc feeding into a videoformat block
    const firstPassIds = new Set(stripIds);
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      const toId = ((l['to'] as string | undefined) ?? '').split(':')[0];
      if (firstPassIds.has(toId)) {
        stripIds.add(((l['from'] as string | undefined) ?? '').split(':')[0]);
      }
    }

    if (stripIds.size > 0) {
      flow.elements = flow.elements.filter(
        (el) => !stripIds.has((el as Record<string, unknown>)['id'] as string),
      );
      flow.blocks = flow.blocks.filter(
        (b) => !stripIds.has((b as Record<string, unknown>)['id'] as string),
      );
      flow.links = flow.links.filter((link) => {
        const l = link as Record<string, unknown>;
        const fromId = ((l['from'] as string | undefined) ?? '').split(':')[0];
        const toId = ((l['to'] as string | undefined) ?? '').split(':')[0];
        return !stripIds.has(fromId) && !stripIds.has(toId);
      });
    }
  }

  // Build cefsrc elements for each graphic assignment (DSK overlays).
  const graphicAssignments = production.graphicAssignments ?? [];
  if (graphicAssignments.length > 0 && mixerBlockId) {
    const graphicsDb = getGraphicsDb();
    let maxDskIndex = -1;

    for (const assignment of graphicAssignments) {
      const dskMatch = /dsk_in_(\d+)$/.exec(assignment.dskInput);
      if (!dskMatch) continue;
      const dskIndex = parseInt(dskMatch[1], 10);
      maxDskIndex = Math.max(maxDskIndex, dskIndex);

      let graphic: GraphicDoc;
      try {
        graphic = await graphicsDb.get(assignment.graphicId) as unknown as GraphicDoc;
      } catch {
        continue; // skip graphics that no longer exist
      }

      const elemId = `e-dsk-${dskIndex}-${endpointSuffix}`;
      const fmtId = `b-dsk-fmt-${dskIndex}-${endpointSuffix}`;
      const dskY = ROW_START + (sortedAssignments.length + dskIndex) * ROW_H;
      flow.elements.push({
        id: elemId,
        element_type: 'cefsrc',
        properties: { url: graphic.url },
        position: [COL_ELEM, dskY],
      });
      const fmtProps: Record<string, unknown> = { resolution: pgmResolution };
      if (pgmFramerate !== undefined) fmtProps['framerate'] = pgmFramerate;
      flow.blocks.push({
        id: fmtId,
        block_definition_id: 'builtin.videoformat',
        name: `Format DSK${dskIndex}`,
        properties: fmtProps,
        position: { x: COL_INPUT, y: dskY },
      });
      flow.links.push(
        { from: `${elemId}:src`, to: `${fmtId}:video_in` },
        { from: `${fmtId}:video_out`, to: `${mixerBlockId}:${assignment.dskInput}` },
      );
    }

    // Set num_dsk_inputs on the vision mixer so DSK pads are available
    if (maxDskIndex >= 0 && mixerBlock) {
      const props = (mixerBlock['properties'] ?? {}) as Record<string, unknown>;
      props['num_dsk_inputs'] = maxDskIndex + 1;
      mixerBlock['properties'] = props;
    }
  }

  // Inject output blocks for each assigned OutputDoc
  const whepOutputEntries: Array<{ outputId: string; endpointId: string }> = [];
  let outputBlockIndex = 0;
  if (outputDocs && outputDocs.length > 0) {
    for (const outputDoc of outputDocs) {
      // Sanitize the output doc ID for use in block/endpoint IDs: strip non-alphanumeric chars,
      // take the last 8 chars. This matters for '__whep__' (virtual) which contains underscores
      // that Strom may reject in endpoint_id.
      const idSlug = outputDoc._id.replace(/[^a-z0-9]/gi, '').slice(-8) || 'out';
      const blockId = `b-out-${idSlug}-${endpointSuffix}`;
      if (outputDoc.outputType === 'whep') {
        const endpointId = `whep-out-${idSlug}-${endpointSuffix}`;
        const auxCount = numAuxBuses ?? 0;
        flow.blocks.push({
          id: blockId,
          block_definition_id: 'builtin.whep_output',
          name: outputDoc.name,
          properties: {
            endpoint_id: endpointId,
            ...(mainAudioSource && { num_audio_tracks: 1 + (monitorAudioSource ? 1 : 0) + auxCount }),
          },
          position: { x: COL_OUTPUT, y: ROW_START + outputBlockIndex * ROW_H },
        });
        if (pgmFeedPad) flow.links.push({ from: pgmFeedPad, to: `${blockId}:video_in` });
        if (mainAudioSource) {
          flow.links.push({ from: mainAudioSource, to: `${blockId}:audio_in` });
          let audioTrack = 1;
          if (monitorAudioSource) {
            flow.links.push({ from: monitorAudioSource, to: `${blockId}:audio_in_${audioTrack}` });
            audioTrack++;
          }
          for (let i = 1; i <= auxCount; i++) {
            if (audioMixerBlockId) {
              flow.links.push({ from: `${audioMixerBlockId}:aux_out_${i}`, to: `${blockId}:audio_in_${audioTrack}` });
              audioTrack++;
            }
          }
        }
        whepOutputEntries.push({ outputId: outputDoc._id, endpointId });
        outputBlockIndex++;
      } else {
        // mpegtssrt or efpsrt — both use the MPEG-TS/SRT output block.
        // Skip if no URL — an empty srt_uri fails at GStreamer READY state.
        if (!outputDoc.url) continue;
        flow.blocks.push({
          id: blockId,
          block_definition_id: 'builtin.mpegtssrt_output',
          name: outputDoc.name,
          properties: {
            srt_uri: outputDoc.url,
            // Single audio track — MPEG-TS muxer stalls when monitor_out has no data (idle monitor bus),
            // causing pipeline-wide back-pressure. Multi-track SRT requires Strom to guarantee continuous
            // audio on monitor_out even when the monitor bus is silent.
          },
          position: { x: COL_OUTPUT, y: ROW_START + outputBlockIndex * ROW_H },
        });
        outputBlockIndex++;
        if (pgmFeedPad) flow.links.push({ from: pgmFeedPad, to: `${blockId}:video_in` });
        if (mainAudioSource) flow.links.push({ from: mainAudioSource, to: `${blockId}:audio_in_0` });
      }
    }
  }

  // Compute encoder block positions — shared by loudness block and group drain placement.
  const encBlocks = flow.blocks.filter(
    (b) => (b as Record<string, unknown>)['block_definition_id'] === 'builtin.videoenc',
  ) as Record<string, unknown>[];
  const encX = encBlocks.length > 0
    ? (encBlocks[0]!['position'] as { x: number; y: number }).x
    : COL_OUTPUT;
  const maxEncY = encBlocks.reduce((max, b) => {
    const y = (b['position'] as { x: number; y: number }).y;
    return y > max ? y : max;
  }, ROW_START);

  // Loudness block — parallel tap, NOT in series. Placed below the video encoders.
  // mixer:main_out → loudness:audio_in → loudness:audio_out → fakesink (drain).
  if (loudnessMainBlockId && audioMixerBlockId) {
    flow.blocks.push({
      id: loudnessMainBlockId,
      block_definition_id: 'builtin.loudness',
      name: 'Main Loudness',
      properties: { interval: '100' },
      position: { x: encX, y: maxEncY + ROW_H },
    });
    const fakesinkId = `e-loudness-sink-${endpointSuffix}`;
    flow.elements.push({
      id: fakesinkId,
      element_type: 'fakesink',
      properties: { sync: false },
      position: [encX, maxEncY + ROW_H * 2],
    } as unknown as typeof flow.elements[number]);
    flow.links.push({ from: `${audioMixerBlockId}:main_out`, to: `${loudnessMainBlockId}:audio_in` });
    flow.links.push({ from: `${loudnessMainBlockId}:audio_out`, to: `${fakesinkId}:sink` });
  }

  // Group output drains — must be wired regardless of whether EBU metering is enabled.
  // Strom crashes at pipeline startup (502) if any group_out_N pad is left unconnected.
  if (audioMixerBlockId && numGroups && numGroups > 0) {
    // Place drains below the loudness block if present, otherwise below the encoders.
    const drainBaseY = maxEncY + ROW_H * (loudnessMainBlockId ? 3 : 2);
    for (let i = 1; i <= numGroups; i++) {
      const drainId = `e-grp-drain-${i}-${endpointSuffix}`;
      flow.elements.push({
        id: drainId,
        element_type: 'fakesink',
        properties: { sync: false },
        position: [encX, drainBaseY + ROW_H * (i - 1)],
      } as unknown as typeof flow.elements[number]);
      flow.links.push({ from: `${audioMixerBlockId}:group_out_${i}`, to: `${drainId}:sink` });
    }
  }

  // POST /api/flows takes the full Flow struct. The server requires 'id' in the
  // body but overwrites it with a new UUID — always use created.flow.id for
  // all subsequent calls.
  const flowName = `${production.name}-${randomUUID().slice(0, 8)}`;
  const created = await strom.flows.create({
    id: randomUUID(),
    name: flowName,
    properties: {
      description: `prod:${production._id}`,
      ephemeral: true,
      ...(clockType ? { clock_type: clockType } : {}),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elements: flow.elements as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: flow.blocks as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    links: flow.links as any,
  });

  const flowId = created.flow.id;

  try {
    await strom.flows.start(flowId);
  } catch (err) {
    // Log a sanitized flow projection — never log block properties (may contain SRT URIs, tokens, passphrases)
    const safeFlow = safeFlowProjection(flow as unknown as Record<string, unknown>);
    console.error('[flow-generator] Flow start failed. Flow topology (properties redacted):',
      JSON.stringify(safeFlow, null, 2));
    // Start failed — clean up the created flow so the endpoint isn't left registered
    try {
      await strom.flows.delete(flowId);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }

  return { flowId, mixerBlockId, audioMixerBlockId, loudnessMainBlockId, whepOutputEntries: whepOutputEntries.length > 0 ? whepOutputEntries : undefined, pgmWhepEndpointId, sourceOffsetBlockIds, sourceAudioOffsetBlockIds };
}

/**
 * Stops and deletes the Strom flow associated with a production.
 * Silently ignores errors (flow may already be gone).
 */
export async function deactivateStromFlow(
  stromFlowId: string,
  strom: StromClient,
): Promise<void> {
  try {
    await strom.flows.stop(stromFlowId);
  } catch {
    // ignore — flow may not be running
  }
  try {
    await strom.flows.delete(stromFlowId);
  } catch {
    // ignore — flow may not exist
  }
}
