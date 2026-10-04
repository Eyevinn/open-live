/**
 * Shape of a Strom flow topology as accepted by flow-generator.ts.
 * Arrays are mutable because the generator pushes dynamic blocks/links/elements
 * into the deep-cloned copy at activation time.
 */
export interface FlowTopology {
  ephemeral?: boolean;
  elements: Record<string, unknown>[];
  blocks: Record<string, unknown>[];
  links: Record<string, unknown>[];
}

/**
 * Default Strom flow topology for Open Live.
 *
 * This is the single supported flow template — hardcoded here so the
 * application has zero CouchDB dependency for its core topology.
 *
 * SRT/EFP input blocks and output blocks are NOT included here — they are
 * injected dynamically by flow-generator.ts at activation time based on
 * production.sources and the assigned OutputDocs.
 */
export const DEFAULT_FLOW: FlowTopology = {
  ephemeral: true,
  elements: [
    {
      id: 'ee26dc9a315d44336ace15b71f7eec523',
      element_type: 'videotestsrc',
      properties: { pattern: 'Spokes' },
      position: [-500.0, 500.0],
    },
    {
      id: 'e040249992a1d4736afaf00dfec6bbb18',
      element_type: 'videotestsrc',
      properties: { pattern: 'Colors' },
      position: [-500.0, 350.0],
    },
  ],
  blocks: [
    {
      id: 'bba5be208b1904f9aae46c38c6c4d23a2',
      block_definition_id: 'builtin.vision_mixer',
      name: 'Mixer',
      properties: {
        num_inputs: '4',
        pgm_resolution: '1280x720',
      },
      position: { x: 250.0, y: 200.0 },
    },
    {
      id: 'bdaf7aa1547ee4a11b8b2b147264b2694',
      block_definition_id: 'builtin.whep_output',
      name: 'Multiview Output',
      properties: { endpoint_id: 'mv', low_latency: true, mode: 'audio_video', num_audio_tracks: 4 },
      position: { x: 850.0, y: 600.0 },
    },
    {
      id: 'b9f3c2e1a4d5b6c7e8f9a0b1c2d3e4f5',
      block_definition_id: 'builtin.whep_output',
      name: 'PGM Output',
      properties: { endpoint_id: 'pgm', low_latency: true, mode: 'audio_video', num_audio_tracks: 4 },
      position: { x: 850.0, y: 300.0 },
    },
    {
      id: 'b035ceff6c25d4bc2bb7a1d36eb0c4308',
      block_definition_id: 'builtin.videoenc',
      name: 'Enc MV',
      properties: { bitrate: 4000 },
      position: { x: 550.0, y: 600.0 },
    },
    {
      id: 'b370f5d3ce9774e869f262aa5714f7a74',
      block_definition_id: 'builtin.videoenc',
      name: 'Enc PGM',
      properties: { bitrate: 10000 },
      position: { x: 550.0, y: 50.0 },
    },
    {
      // Shared low-bitrate program encode for WHEP viewers (issue #413). The
      // 10 Mbit/s Enc PGM encode crosses whepserversink's GCC pacing threshold,
      // delaying every program frame to viewers by ~26 ms; a ~4 Mbit/s encode
      // ships each frame in one burst. Recorder / RTMP / SRT stay on Enc PGM.
      id: 'b1ce7a9d4e5f604bc8aa7d36eb0c4f413',
      block_definition_id: 'builtin.videoenc',
      name: 'Enc View',
      properties: { bitrate: 4000 },
      position: { x: 550.0, y: 300.0 },
    },
    {
      id: 'b08c7a35f181a4f6a90f5e2c517df284a',
      block_definition_id: 'builtin.mixer',
      name: 'Audio Mixer',
      properties: { num_aux_buses: 2, num_channels: 2, num_groups: 0 },
      position: { x: 250.0, y: 650.0 },
    },
    {
      id: 'b0454efed640a402cafb4727e6a259514',
      block_definition_id: 'builtin.mpegtssrt_output',
      name: 'SRT Output',
      properties: { srt_uri: 'srt://:6000?mode=listener' },
      position: { x: 850.0, y: 50.0 },
    },
    {
      id: 'bc8ed07a386a04aa5957bcad179a932c1',
      block_definition_id: 'builtin.videoformat',
      name: 'Format V3',
      properties: { resolution: '1280x720' },
      position: { x: -250.0, y: 500.0 },
    },
    {
      id: 'b5f982d927d42434dbb114ab629124662',
      block_definition_id: 'builtin.videoformat',
      name: 'Format V2',
      properties: { resolution: '1280x720' },
      position: { x: -250.0, y: 350.0 },
    },
  ],
  links: [
    // PGM/MV video routing
    { from: 'bba5be208b1904f9aae46c38c6c4d23a2:pgm_out',       to: 'b370f5d3ce9774e869f262aa5714f7a74:video_in' },
    { from: 'bba5be208b1904f9aae46c38c6c4d23a2:pgm_out',       to: 'b1ce7a9d4e5f604bc8aa7d36eb0c4f413:video_in' },
    { from: 'b370f5d3ce9774e869f262aa5714f7a74:encoded_out',    to: 'b0454efed640a402cafb4727e6a259514:video_in' },
    // PGM WHEP viewers get the low-bitrate Enc View encode (issue #413), not Enc PGM.
    { from: 'b1ce7a9d4e5f604bc8aa7d36eb0c4f413:encoded_out',    to: 'b9f3c2e1a4d5b6c7e8f9a0b1c2d3e4f5:video_in' },
    { from: 'bba5be208b1904f9aae46c38c6c4d23a2:multiview_out',  to: 'b035ceff6c25d4bc2bb7a1d36eb0c4308:video_in' },
    { from: 'b035ceff6c25d4bc2bb7a1d36eb0c4308:encoded_out',    to: 'bdaf7aa1547ee4a11b8b2b147264b2694:video_in' },
    // Static video inputs: test sources (V2, V3)
    { from: 'e040249992a1d4736afaf00dfec6bbb18:src',            to: 'b5f982d927d42434dbb114ab629124662:video_in' },
    { from: 'b5f982d927d42434dbb114ab629124662:video_out',      to: 'bba5be208b1904f9aae46c38c6c4d23a2:video_in_2' },
    { from: 'ee26dc9a315d44336ace15b71f7eec523:src',            to: 'bc8ed07a386a04aa5957bcad179a932c1:video_in' },
    { from: 'bc8ed07a386a04aa5957bcad179a932c1:video_out',      to: 'bba5be208b1904f9aae46c38c6c4d23a2:video_in_3' },
    // Audio mixer → all consumers
    { from: 'b08c7a35f181a4f6a90f5e2c517df284a:main_out',    to: 'b0454efed640a402cafb4727e6a259514:audio_in_0' },
    { from: 'b08c7a35f181a4f6a90f5e2c517df284a:main_out',    to: 'bba5be208b1904f9aae46c38c6c4d23a2:pgm_audio_in' },
    // Audio mixer → MV WHEP: main, monitor, aux1, aux2
    { from: 'b08c7a35f181a4f6a90f5e2c517df284a:main_out',    to: 'bdaf7aa1547ee4a11b8b2b147264b2694:audio_in'   },
    { from: 'b08c7a35f181a4f6a90f5e2c517df284a:monitor_out', to: 'bdaf7aa1547ee4a11b8b2b147264b2694:audio_in_1' },
    { from: 'b08c7a35f181a4f6a90f5e2c517df284a:aux_out_1',   to: 'bdaf7aa1547ee4a11b8b2b147264b2694:audio_in_2' },
    { from: 'b08c7a35f181a4f6a90f5e2c517df284a:aux_out_2',   to: 'bdaf7aa1547ee4a11b8b2b147264b2694:audio_in_3' },
    // Audio mixer → PGM WHEP: main, monitor, aux1, aux2
    { from: 'b08c7a35f181a4f6a90f5e2c517df284a:main_out',    to: 'b9f3c2e1a4d5b6c7e8f9a0b1c2d3e4f5:audio_in'   },
    { from: 'b08c7a35f181a4f6a90f5e2c517df284a:monitor_out', to: 'b9f3c2e1a4d5b6c7e8f9a0b1c2d3e4f5:audio_in_1' },
    { from: 'b08c7a35f181a4f6a90f5e2c517df284a:aux_out_1',   to: 'b9f3c2e1a4d5b6c7e8f9a0b1c2d3e4f5:audio_in_2' },
    { from: 'b08c7a35f181a4f6a90f5e2c517df284a:aux_out_2',   to: 'b9f3c2e1a4d5b6c7e8f9a0b1c2d3e4f5:audio_in_3' },
    // Dynamic SRT/EFP source links are added by flow-generator at activation
  ],
};
