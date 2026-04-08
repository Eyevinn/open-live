// --------------- Macro types ---------------

export type MacroActionType = 'CUT' | 'TRANSITION' | 'TAKE' | 'GRAPHIC_ON' | 'GRAPHIC_OFF' | 'DSK_TOGGLE';

export interface MacroAction {
  type: MacroActionType;
  sourceId?: string;
  transitionType?: string;
  durationMs?: number;
  overlayId?: string;
  layer?: number;
  visible?: boolean;
}

export interface Macro {
  id: string;      // "macro-<uuid>"
  slot: number;    // 0-7 (F1-F8)
  label: string;
  color: string;   // hex color, e.g. "#3B82F6"
  actions: MacroAction[];
}

// --------------- Audio element types ---------------

export interface AudioElement {
  id: string;
  blockId: string;
  elementId: string;
  label: string;
}

// --------------- Source types ---------------

export type StreamType = 'srt' | 'whip';

export type SourceStatus = 'active' | 'inactive';

export interface SourceDoc {
  _id: string;
  _rev?: string;
  type: 'source';
  name: string;
  address: string;
  streamType: StreamType;
  status: SourceStatus;
  liveCamera?: boolean;
  createdAt: string;
  updatedAt: string;
}

// --------------- Template types ---------------

export interface FlowElement {
  id: string;
  element_type: string;
  properties?: Record<string, unknown>;
  block_id?: string;
  x?: number;
  y?: number;
}

export interface FlowLink {
  from_element: string;
  from_pad?: string;
  to_element: string;
  to_pad?: string;
}

export interface FlowBlock {
  id: string;
  name: string;
  category?: string;
  description?: string;
  elements?: FlowElement[];
  links?: FlowLink[];
  inputs?: string[];
  outputs?: string[];
  properties?: Record<string, unknown>;
}

/**
 * Describes a parametric input slot in a template.
 * When activating a production, the flow generator patches
 * the source address into the block identified by `blockId`,
 * at the property path `addressProperty`.
 */
export interface TemplateInputSlot {
  /** Logical input name — must match `mixerInput` in ProductionSourceAssignment */
  id: string;
  /** ID of the block in the flow's blocks[] array that receives this source */
  blockId: string;
  /** Property name on that block that takes the source address (e.g. 'uri', 'address') */
  addressProperty: string;
}

export interface StromFlowTemplate {
  _id: string;
  _rev?: string;
  type: 'template';
  name: string;
  description?: string;
  /**
   * Raw Strom flow JSON — stored and forwarded as-is.
   * Using Record<string, unknown>[] to accommodate the full Strom block
   * schema (block_definition_id, position, computed_external_pads, etc.)
   * without fighting the type system.
   */
  flow: {
    elements: Record<string, unknown>[];
    blocks: Record<string, unknown>[];
    links: Record<string, unknown>[];
  };
  /** Defines which blocks are parametric source inputs */
  inputs: TemplateInputSlot[];
  audioElements: AudioElement[];
  createdAt: string;
  updatedAt: string;
}

// --------------- Production types ---------------

/**
 * Maps a source from the sources catalogue to a mixer input in the template.
 */
export interface ProductionSourceAssignment {
  sourceId: string;   // references SourceDoc._id
  mixerInput: string; // references TemplateInputSlot.id
}

export type PipelineStatus = 'stopped' | 'running';

export interface Pipeline {
  stromConfig: Record<string, unknown> | null;
  status: PipelineStatus;
}

export interface GraphicOverlay {
  id: string;
  name: string;
  template: string;
  params: Record<string, unknown>;
  active: boolean;
}

export interface Tally {
  pgm: string | null;
  pvw: string | null;
}

export type ProductionStatus = 'active' | 'inactive';

export interface ProductionDoc {
  _id: string;
  _rev?: string;
  type: 'production';
  name: string;
  status: ProductionStatus;
  /** Source-to-mixer-input assignments for this production */
  sources: ProductionSourceAssignment[];
  /** ID of the StromFlowTemplate to use when activating */
  templateId?: string;
  /** ID of the running Strom flow (set on activate, cleared on deactivate) */
  stromFlowId?: string;
  pipeline: Pipeline;
  graphics: GraphicOverlay[];
  macros: Macro[];
  tally: Tally;
  mixerBlockId?: string;
  createdAt: string;
  updatedAt: string;
}
