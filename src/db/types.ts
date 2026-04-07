export type SourceType = 'camera' | 'srt' | 'ndi' | 'test';

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  liveCamera?: boolean;
  config: Record<string, unknown>;
}

export type SourceStatus = 'active' | 'inactive';

export interface SourceDoc {
  _id: string;
  _rev?: string;
  type: 'source';
  name: string;
  address: string;
  status: SourceStatus;
  liveCamera?: boolean;
  createdAt: string;
  updatedAt: string;
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

export type ProductionStatus = 'idle' | 'active' | 'on-air';

export interface ProductionDoc {
  _id: string;
  _rev?: string;
  type: 'production';
  name: string;
  status: ProductionStatus;
  sources: Source[];
  pipeline: Pipeline;
  graphics: GraphicOverlay[];
  tally: Tally;
  createdAt: string;
  updatedAt: string;
}
