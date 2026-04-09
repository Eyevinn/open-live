import { getTemplatesDb, getSourcesDb, getDb } from './index.js';
import type { ProductionDoc } from './types.js';
import type { StromFlowTemplate, SourceDoc } from './types.js';

/**
 * Well-known CouchDB ID for the default vision-mixer template.
 * Using a fixed ID lets us check for existence with a single GET
 * instead of querying by name.
 */
const DEFAULT_TEMPLATE_ID = 'tmpl-default-vision-mixer';

/**
 * The default Open Live template: 2-input vision mixer (SRT + WHIP),
 * PGM and multiview WHEP outputs. This is the template the user designed
 * and verified against a live Strom instance.
 *
 * Flow content is stored in Strom's native JSON format so it can be
 * forwarded to POST /api/flows without transformation.
 *
 * Parametric inputs (source address slots):
 *   - video_in_0 → block b85a... (builtin.mpegtssrt_input), property: srt_uri
 *   - video_in_1 → block b826... (builtin.whip_input),      property: endpoint_id
 */
const DEFAULT_TEMPLATE: Omit<StromFlowTemplate, '_id' | '_rev'> = {
  type: 'template',
  name: 'Open Live Default',
  description: 'Vision mixer: SRT input (V0) + WHIP input (V1), PGM and multiview WHEP outputs',
  flow: {
    elements: [
      {
        id: 'ea5c42cb9a54f42fd8ef53d6a3f4c2ab1',
        element_type: 'videotestsrc',
        properties: { pattern: 'Pinwheel' },
        position: [50.0, 800.0],
      },
      {
        id: 'ef215bdc7a9814270ab2137eb65ff771e',
        element_type: 'videotestsrc',
        properties: { pattern: 'Colors' },
        position: [50.0, 700.0],
      },
    ],
    blocks: [
      {
        id: 'b0428b4f5e08f4f59a395e3fcb123d6d5',
        block_definition_id: 'builtin.vision_mixer',
        name: 'Mixer',
        properties: {
          compositor_preference: 'cpu',
          input_0_alpha: 0.0,
          input_1_alpha: 0.0,
          input_2_alpha: 0.0,
          input_3_alpha: 0.0,
          input_4_alpha: 0.0,
          input_5_alpha: 0.0,
          input_6_alpha: 0.0,
          input_7_alpha: 0.0,
          input_8_alpha: 0.0,
          input_9_alpha: 0.0,
          multiview_resolution: '640x360',
          pgm_resolution: '640x360',
        },
        position: { x: 750.0, y: 300.0 },
      },
      {
        id: 'bbc31abafa6d44469b9793e5b123474c9',
        block_definition_id: 'builtin.whep_output',
        name: 'PGM Output',
        properties: { endpoint_id: 'pgm' },
        position: { x: 1300.0, y: 250.0 },
      },
      {
        id: 'bf3796dfea9fc4a04aee0dc5f673a3bbe',
        block_definition_id: 'builtin.whep_output',
        name: 'Multiview Output',
        properties: { endpoint_id: 'mv' },
        position: { x: 1300.0, y: 400.0 },
      },
      {
        id: 'b66653ee5dd064885b072787ebc192f1d',
        block_definition_id: 'builtin.videoformat',
        name: 'Format V3',
        properties: { resolution: '640x360' },
        position: { x: 300.0, y: 800.0 },
      },
      {
        id: 'b9f33f901ac4a43c99d7fa27d474ca0a5',
        block_definition_id: 'builtin.videoformat',
        name: 'Format V2',
        properties: { resolution: '640x360' },
        position: { x: 300.0, y: 700.0 },
      },
      {
        id: 'b8aac53567d734cb0961329773c352fe1',
        block_definition_id: 'builtin.videoenc',
        name: 'Enc MV',
        properties: {},
        position: { x: 1050.0, y: 400.0 },
      },
      {
        id: 'b4f7ddae23338475db80497ac69b83fd4',
        block_definition_id: 'builtin.videoenc',
        name: 'Enc PGM',
        properties: {},
        position: { x: 1050.0, y: 250.0 },
      },
      // ---- Parametric source input blocks (patched at activation time) ----
      {
        id: 'b85a6285341834c0195979d764de64f67',
        block_definition_id: 'builtin.mpegtssrt_input',
        name: 'SRT Input (V0)',
        properties: {
          // Default placeholder — overwritten at activation with the
          // assigned source's address
          srt_uri: 'srt://127.0.0.1:5005?mode=caller',
        },
        position: { x: 300.0, y: 250.0 },
      },
      {
        id: 'b8262bb1aae074fc3bab9ed6f51f67eba',
        block_definition_id: 'builtin.whip_input',
        name: 'WHIP Input (V1)',
        properties: {
          // Default placeholder — overwritten at activation with the
          // assigned source's endpoint_id
          endpoint_id: 'whip1',
        },
        position: { x: 300.0, y: 400.0 },
      },
    ],
    links: [
      // videotestsrc elements → videoformat blocks (test/fallback inputs)
      { from: 'ef215bdc7a9814270ab2137eb65ff771e:src', to: 'b9f33f901ac4a43c99d7fa27d474ca0a5:video_in' },
      { from: 'ea5c42cb9a54f42fd8ef53d6a3f4c2ab1:src', to: 'b66653ee5dd064885b072787ebc192f1d:video_in' },
      // Source inputs → mixer
      { from: 'b85a6285341834c0195979d764de64f67:video_out', to: 'b0428b4f5e08f4f59a395e3fcb123d6d5:video_in_0' },
      { from: 'b8262bb1aae074fc3bab9ed6f51f67eba:video_out', to: 'b0428b4f5e08f4f59a395e3fcb123d6d5:video_in_1' },
      { from: 'b9f33f901ac4a43c99d7fa27d474ca0a5:video_out', to: 'b0428b4f5e08f4f59a395e3fcb123d6d5:video_in_2' },
      { from: 'b66653ee5dd064885b072787ebc192f1d:video_out', to: 'b0428b4f5e08f4f59a395e3fcb123d6d5:video_in_3' },
      // Mixer → encoders → WHEP outputs
      { from: 'b0428b4f5e08f4f59a395e3fcb123d6d5:pgm_out',       to: 'b4f7ddae23338475db80497ac69b83fd4:video_in' },
      { from: 'b4f7ddae23338475db80497ac69b83fd4:encoded_out',    to: 'bbc31abafa6d44469b9793e5b123474c9:video_in' },
      { from: 'b0428b4f5e08f4f59a395e3fcb123d6d5:multiview_out',  to: 'b8aac53567d734cb0961329773c352fe1:video_in' },
      { from: 'b8aac53567d734cb0961329773c352fe1:encoded_out',    to: 'bf3796dfea9fc4a04aee0dc5f673a3bbe:video_in' },
    ],
  },
  /**
   * Parametric input slots: map logical input names to the block + property
   * that receives the source address at activation time.
   */
  inputs: [
    {
      id: 'video_in_0',
      blockId: 'b85a6285341834c0195979d764de64f67',
      addressProperty: 'srt_uri',
    },
    {
      id: 'video_in_1',
      blockId: 'b8262bb1aae074fc3bab9ed6f51f67eba',
      addressProperty: 'endpoint_id',
    },
  ],
  audioElements: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/**
 * Ensures the default template is up to date in CouchDB.
 * Always overwrites the existing template so deploys pick up seed changes.
 */
export async function seedDefaultTemplate(): Promise<void> {
  const db = getTemplatesDb();
  try {
    const existing = await db.get(DEFAULT_TEMPLATE_ID) as { _rev: string };
    await db.insert({ ...DEFAULT_TEMPLATE, _rev: existing._rev } as never, DEFAULT_TEMPLATE_ID);
  } catch {
    // Not found — insert fresh
    await db.insert(DEFAULT_TEMPLATE as never, DEFAULT_TEMPLATE_ID);
  }
}

// ---------------------------------------------------------------------------
// Dev / test fixtures
// ---------------------------------------------------------------------------

const DEV_TEMPLATE_ID = 'tmpl-dev-test-no-sources';

/**
 * Development template: 4 videotestsrc elements (Pinwheel, Colors, Balls, Snow)
 * wired directly into the vision mixer. No SRT/WHIP inputs — activates instantly
 * with no sources assigned. Use this for local dev and CI testing.
 */
const DEV_TEMPLATE: Omit<StromFlowTemplate, '_id' | '_rev'> = {
  type: 'template',
  name: 'Dev Test (No Sources)',
  description: 'Four videotestsrc patterns into the vision mixer. No external sources needed.',
  flow: {
    elements: [
      { id: 'e-dev-ts-1', element_type: 'videotestsrc', properties: { pattern: 'Pinwheel' }, position: [50, 100] },
      { id: 'e-dev-ts-2', element_type: 'videotestsrc', properties: { pattern: 'Colors' },   position: [50, 250] },
      { id: 'e-dev-ts-3', element_type: 'videotestsrc', properties: { pattern: 'Pinwheel' }, position: [50, 400] },
      { id: 'e-dev-ts-4', element_type: 'videotestsrc', properties: { pattern: 'Colors' },   position: [50, 550] },
    ],
    blocks: [
      {
        id: 'b-dev-fmt-1', block_definition_id: 'builtin.videoformat', name: 'Format 1',
        properties: { resolution: '640x360' }, position: { x: 300, y: 100 },
      },
      {
        id: 'b-dev-fmt-2', block_definition_id: 'builtin.videoformat', name: 'Format 2',
        properties: { resolution: '640x360' }, position: { x: 300, y: 250 },
      },
      {
        id: 'b-dev-fmt-3', block_definition_id: 'builtin.videoformat', name: 'Format 3',
        properties: { resolution: '640x360' }, position: { x: 300, y: 400 },
      },
      {
        id: 'b-dev-fmt-4', block_definition_id: 'builtin.videoformat', name: 'Format 4',
        properties: { resolution: '640x360' }, position: { x: 300, y: 550 },
      },
      {
        id: 'b-dev-mixer', block_definition_id: 'builtin.vision_mixer', name: 'Mixer',
        properties: {
          compositor_preference: 'cpu',
          input_0_alpha: 0.0, input_1_alpha: 0.0,
          input_2_alpha: 0.0, input_3_alpha: 0.0,
          multiview_resolution: '640x360', pgm_resolution: '640x360',
        },
        position: { x: 600, y: 300 },
      },
      {
        id: 'b-dev-enc-pgm', block_definition_id: 'builtin.videoenc', name: 'Enc PGM',
        properties: {}, position: { x: 900, y: 200 },
      },
      {
        id: 'b-dev-enc-mv', block_definition_id: 'builtin.videoenc', name: 'Enc MV',
        properties: {}, position: { x: 900, y: 400 },
      },
      {
        id: 'b-dev-pgm-out', block_definition_id: 'builtin.whep_output', name: 'PGM Output',
        properties: { endpoint_id: 'pgm' }, position: { x: 1150, y: 200 },
      },
      {
        id: 'b-dev-mv-out', block_definition_id: 'builtin.whep_output', name: 'Multiview Output',
        properties: { endpoint_id: 'mv' }, position: { x: 1150, y: 400 },
      },
    ],
    links: [
      // videotestsrc elements → videoformat blocks
      { from: 'e-dev-ts-1:src', to: 'b-dev-fmt-1:video_in' },
      { from: 'e-dev-ts-2:src', to: 'b-dev-fmt-2:video_in' },
      { from: 'e-dev-ts-3:src', to: 'b-dev-fmt-3:video_in' },
      { from: 'e-dev-ts-4:src', to: 'b-dev-fmt-4:video_in' },
      // videoformat blocks → mixer inputs
      { from: 'b-dev-fmt-1:video_out', to: 'b-dev-mixer:video_in_0' },
      { from: 'b-dev-fmt-2:video_out', to: 'b-dev-mixer:video_in_1' },
      { from: 'b-dev-fmt-3:video_out', to: 'b-dev-mixer:video_in_2' },
      { from: 'b-dev-fmt-4:video_out', to: 'b-dev-mixer:video_in_3' },
      // mixer → encoders → WHEP outputs
      { from: 'b-dev-mixer:pgm_out',       to: 'b-dev-enc-pgm:video_in' },
      { from: 'b-dev-enc-pgm:encoded_out', to: 'b-dev-pgm-out:video_in' },
      { from: 'b-dev-mixer:multiview_out', to: 'b-dev-enc-mv:video_in' },
      { from: 'b-dev-enc-mv:encoded_out',  to: 'b-dev-mv-out:video_in' },
    ],
  },
  /**
   * Parametric input slots: id matches the mixer pad name so getMixerInput()
   * can resolve source → mixer input at runtime. addressProperty is empty
   * because these videotestsrc elements are hardwired in the flow — no address
   * patching is needed at activation time.
   */
  inputs: [
    { id: 'video_in_0', blockId: 'b-dev-fmt-1', addressProperty: '' },
    { id: 'video_in_1', blockId: 'b-dev-fmt-2', addressProperty: '' },
    { id: 'video_in_2', blockId: 'b-dev-fmt-3', addressProperty: '' },
    { id: 'video_in_3', blockId: 'b-dev-fmt-4', addressProperty: '' },
  ],
  audioElements: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const DEV_SOURCES: Array<{ id: string; doc: Omit<SourceDoc, '_id' | '_rev'> }> = [
  {
    id: 'src-dev-pat-1',
    doc: {
      type: 'source',
      name: 'Pinwheel A',
      address: '',
      streamType: 'srt',
      status: 'inactive',
      liveCamera: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  },
  {
    id: 'src-dev-pat-2',
    doc: {
      type: 'source',
      name: 'Colors A',
      address: '',
      streamType: 'srt',
      status: 'inactive',
      liveCamera: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  },
  {
    id: 'src-dev-pat-3',
    doc: {
      type: 'source',
      name: 'Pinwheel B',
      address: '',
      streamType: 'srt',
      status: 'inactive',
      liveCamera: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  },
  {
    id: 'src-dev-pat-4',
    doc: {
      type: 'source',
      name: 'Colors B',
      address: '',
      streamType: 'srt',
      status: 'inactive',
      liveCamera: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  },
];

const DEV_PRODUCTION_ID = 'prod-dev-test';

/**
 * Dev production pre-wired to the dev template and the 4 test pattern sources.
 * Source assignments map each pattern source to its fixed mixer pad — no address
 * patching occurs at activation because addressProperty is empty on the template inputs.
 */
const DEV_PRODUCTION: Omit<ProductionDoc, '_id' | '_rev'> = {
  type: 'production',
  name: 'Dev Test Production',
  status: 'inactive',
  templateId: DEV_TEMPLATE_ID,
  sources: [
    { sourceId: 'src-dev-pat-1', mixerInput: 'video_in_0' },
    { sourceId: 'src-dev-pat-2', mixerInput: 'video_in_1' },
    { sourceId: 'src-dev-pat-3', mixerInput: 'video_in_2' },
    { sourceId: 'src-dev-pat-4', mixerInput: 'video_in_3' },
  ],
  pipeline: { stromConfig: null, status: 'stopped' },
  graphics: [],
  macros: [],
  tally: { pgm: null, pvw: null },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function seedOne<T extends object>(
  db: ReturnType<typeof getTemplatesDb>,
  id: string,
  doc: T,
): Promise<void> {
  try {
    await (db as unknown as { get: (id: string) => Promise<unknown> }).get(id);
  } catch {
    await (db as unknown as { insert: (doc: T, id: string) => Promise<unknown> }).insert(doc, id);
  }
}

export async function seedDevFixtures(): Promise<void> {
  const templatesDb = getTemplatesDb();
  // Always upsert the dev template so changes to inputs/flow are picked up on restart
  try {
    const existing = await templatesDb.get(DEV_TEMPLATE_ID) as { _rev: string };
    await templatesDb.insert({ ...DEV_TEMPLATE, _rev: existing._rev } as never, DEV_TEMPLATE_ID);
  } catch {
    await templatesDb.insert(DEV_TEMPLATE as never, DEV_TEMPLATE_ID);
  }

  const sourcesDb = getSourcesDb();
  for (const { id, doc } of DEV_SOURCES) {
    await seedOne(sourcesDb as unknown as ReturnType<typeof getTemplatesDb>, id, doc as never);
  }

  const productionsDb = getDb() as unknown as ReturnType<typeof getTemplatesDb>;
  await seedOne(productionsDb, DEV_PRODUCTION_ID, DEV_PRODUCTION as never);
}
