import { getTemplatesDb } from './index.js';
import type { StromFlowTemplate } from './types.js';

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
          input_0_alpha: 1.0,
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
 * Ensures the default template exists in CouchDB.
 * Called once at startup — idempotent.
 */
export async function seedDefaultTemplate(): Promise<void> {
  const db = getTemplatesDb();
  try {
    await db.get(DEFAULT_TEMPLATE_ID);
    // Already exists — nothing to do
  } catch {
    // Not found — insert it with the well-known ID
    await db.insert(DEFAULT_TEMPLATE as never, DEFAULT_TEMPLATE_ID);
  }
}
