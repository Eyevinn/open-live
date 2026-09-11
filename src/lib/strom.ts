/**
 * Strom API client — generated from openapi.json v0.4.5
 * https://github.com/Eyevinn/strom
 */
import { WebSocket as WsWebSocket } from 'ws'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StromError {
  error: string
}

export interface SystemInfo {
  version: string
  git_commit?: string
  git_tag?: string
  git_branch?: string
  dirty?: boolean
  build_timestamp?: string
}

export interface AuthStatusResponse {
  authenticated: boolean
  username?: string
}

export interface LoginRequest {
  username: string
  password: string
}

export interface LoginResponse {
  authenticated: boolean
  message?: string
}

// --- Elements ---

export interface ElementProperty {
  name: string
  type: string
  default?: unknown
  description?: string
  mutable_in_playing?: boolean
  mutable_in_paused?: boolean
  mutable_in_ready?: boolean
}

export interface ElementInfo {
  name: string
  long_name?: string
  description?: string
  properties?: ElementProperty[]
  pad_templates?: PadTemplate[]
}

export interface PadTemplate {
  name: string
  direction: 'src' | 'sink'
  presence: string
  caps?: string
}

export interface ElementListResponse {
  elements: string[]
}

export interface ElementInfoResponse {
  element: ElementInfo
}

// --- Blocks ---

export interface FlowElement {
  id: string
  element_type: string
  properties?: Record<string, unknown>
  block_id?: string
  x?: number
  y?: number
}

export interface FlowLink {
  /** Format: "element_id" or "element_id:pad_name" */
  from: string
  /** Format: "element_id" or "element_id:pad_name" */
  to: string
}

export interface BlockDefinition {
  id: string
  name: string
  category?: string
  description?: string
  elements: FlowElement[]
  links: FlowLink[]
  inputs?: string[]
  outputs?: string[]
}

export interface BlockResponse {
  block: BlockDefinition
}

export interface BlockListResponse {
  blocks: BlockDefinition[]
}

export interface BlockCategoriesResponse {
  categories: string[]
}

export interface CreateBlockRequest {
  id: string
  name: string
  category?: string
  description?: string
  elements: FlowElement[]
  links: FlowLink[]
}

// --- Flows ---

export type FlowState = 'idle' | 'playing' | 'paused'

/**
 * A block instance in a flow — references a block definition by ID and
 * provides property values for it. This is the runtime shape stored in
 * Flow.blocks, distinct from BlockDefinition (the catalog entry).
 */
export interface BlockInstance {
  id: string
  block_definition_id: string
  name?: string | null
  properties: Record<string, unknown>
  position: { x: number; y: number }
}

export interface FlowProperties {
  ephemeral?: boolean
  description?: string
  clock_type?: string
  auto_restart?: boolean
}

export interface Flow {
  id: string
  name: string
  running?: boolean
  properties?: FlowProperties
  elements?: FlowElement[]
  blocks?: BlockInstance[]
  links?: FlowLink[]
}

export interface FlowResponse {
  flow: Flow
}

export interface FlowListResponse {
  flows: Flow[]
}

/**
 * POST /api/flows requires a client-supplied id (UUID).
 * The deployed Strom version deserialises this as the full Flow struct,
 * so blocks/elements/links can be included on creation.
 */
// POST /api/flows takes the full Flow struct (id required, overwritten server-side)
export type CreateFlowRequest = Flow

export interface UpdateFlowPropertiesRequest {
  ephemeral?: boolean
  description?: string
  clock_type?: string
  properties?: Record<string, unknown>
}

// --- Flow operations ---

export type TransitionType = string

export interface TriggerTransitionRequest {
  from_input: number
  to_input: number
  transition_type: TransitionType
  duration_ms?: number
}

export interface TransitionResponse {
  success: boolean
}

/**
 * Strom Source union — externally-tagged JSON: { "input": N } or { "pip": N }.
 * Confirmed from origin/main:types/src/vision_mixer.rs — #[serde(rename_all = "lowercase")].
 */
export type StromSource = { input: number } | { pip: number }

/**
 * Strom SelectPreviewRequest (Strom 0.5+): { source: StromSource }
 * Changed from { input: N, multi?: bool } in Strom 0.4.x.
 * Route also changed from POST to PUT — confirmed origin/main:backend/src/lib.rs.
 */
export interface SelectPreviewRequest {
  source: StromSource
}

/**
 * A rectangular zone in normalised [0,1] coordinates within the PiP area.
 * Our own concept — not a Strom API type.
 */
export interface PipZone {
  rect: { x: number; y: number; w: number; h: number } | null
  capacity: number | null
  sources: number[]
  border?: { color: string; width: number } | null   // PR #625: ZoneBorder
}

/**
 * Normalized per-source crop: fraction of the source hidden from each edge.
 * All components 0.0–1.0; all zero = no crop.
 * Strom 0.6.2+: PUT /pip/{idx} accepts transforms keyed by input index.
 */
export interface SourceCrop {
  left: number
  top: number
  right: number
  bottom: number
}

/** Per-source crop map for a PiP slot: input index → SourceCrop. */
export type PipTransforms = Record<number, SourceCrop>

/** Negotiated resolution of a video input (from VisionMixerState.input_resolutions). */
export interface InputResolution {
  width: number
  height: number
}

/**
 * Layout config for one PiP slot (background + overlay zones + per-source crops).
 * Our own concept — mirrors Strom's PipState.
 */
export interface PipConfig {
  bg: number | null
  zones: PipZone[]
  transforms: PipTransforms
}

/**
 * Body for PUT /api/flows/{id}/blocks/{bid}/pip/{pip_idx}.
 * Strom 0.6.2+: transforms field added (serde(default) — safe to omit on older Strom).
 */
export interface UpdatePipConfigRequest {
  bg?: number | null
  zones: PipZone[]
  transforms?: PipTransforms
}

export interface UpdatePipConfigResponse {
  bg: number | null
  zones: PipZone[]
  transforms: PipTransforms
}

/** Runtime PiP state returned by GET state and included in VisionMixerStateResponse. */
export interface StromPipState {
  bg: number | null
  zones: PipZone[]
  transforms: PipTransforms
}

export interface SelectPreviewResponse {
  preview_input: number
  program_input: number
  preview_inputs: number[]
  program_inputs: number[]
}

// ---------------------------------------------------------------------------
// Video Effects (PR #626 + #639)
// ---------------------------------------------------------------------------

// #[serde(tag = "type", rename_all = "snake_case")]
export type VideoEffect =
  | { type: 'none' }
  | { type: 'chroma_key'; key_color?: string; similarity?: number; smoothness?: number; spill?: number }
  | { type: 'pixelate'; block_size?: number }
  | { type: 'blur'; radius?: number }
  | { type: 'duotone'; low?: string; high?: string; mix?: number }
  | { type: 'vignette'; amount?: number; softness?: number }
  | { type: 'vhs'; intensity?: number }
  | { type: 'old_film'; intensity?: number }
  | { type: 'edge_glow'; color?: string; intensity?: number }
  | { type: 'crt'; intensity?: number }
  | { type: 'halftone'; dot_size?: number }
  | { type: 'thermal'; intensity?: number }
  | { type: 'night_vision'; intensity?: number }
  | { type: 'posterize'; levels?: number }
  | { type: 'underwater'; intensity?: number }
  | { type: 'color_correct'; brightness?: number; contrast?: number; saturation?: number; hue?: number; gamma?: number; temperature?: number; tint?: number }

// EffectTarget — exact serde from tests:
// EffectTarget::Input(2) → {"input": 2}
// EffectTarget::Master  → "master"
export type EffectTarget = { input: number } | 'master'

export interface SetVideoEffectRequest {
  target: EffectTarget
  effect: VideoEffect
}

export interface SetVideoEffectResponse {
  message: string
  effect: VideoEffect
}

export interface VisionMixerStateResponse {
  /** First input in PGM group (0-based, backward compat) */
  program_input: number
  /** First input in PVW group (0-based, backward compat) */
  preview_input: number
  program_inputs: number[]
  preview_inputs: number[]
  num_inputs: number
  input_labels: string[]
  ftb_active: boolean
  dsk_enabled: boolean[]
  overlay_alpha: number
  /** Per-PiP runtime state (Strom 0.6.2+, serde(default) → [] on older Strom). */
  pips: StromPipState[]
  /** Negotiated resolution per input (Strom 0.6.2+, serde(default) → [] on older Strom). */
  input_resolutions: Array<InputResolution | null>
  /** Whether the FX engine is available (false on CPU backend or enable_fx=false). PR #626. */
  fx_available?: boolean
  /** Per-input video effect (length = num_inputs, serde(default) → [] on older Strom). PR #626. */
  input_effects?: VideoEffect[]
  /** Master output video effect (serde(default) → none on older Strom). PR #626. */
  master_effect?: VideoEffect
}

export interface AnimateInputRequest {
  /** 0-based input index */
  input: number
  xpos?: number
  ypos?: number
  width?: number
  height?: number
  duration_ms?: number
}

export interface SetBackgroundRequest {
  input?: string | null
}

export interface SetBackgroundResponse {
  input?: string | null
}

export interface DskToggleRequest {
  dsk: number
  enabled: boolean
}

export interface DskToggleResponse {
  dsk: number
  enabled: boolean
  message: string
}

export interface FadeToBlackRequest {
  active?: boolean
  duration_ms: number
}

export interface FadeToBlackResponse {
  active: boolean
}

export interface OverlayAlphaRequest {
  alpha: number
}

export interface OverlayAlphaResponse {
  alpha: number
}

// --- Block properties ---

export interface UpdateBlockPropertiesRequest {
  properties: Record<string, unknown>
  ramp_ms?: number
  ramp_ms_overrides?: Record<string, number>
}

export interface BlockPropertiesResponse {
  block_id: string
  properties: Record<string, unknown>
  rejected: Record<string, string>
}

// --- Element/pad properties ---

export interface ElementPropertiesResponse {
  element_id: string
  properties: Record<string, unknown>
}

export interface PadPropertiesResponse {
  element_id: string
  pad_name: string
  properties: Record<string, unknown>
}

export interface UpdatePropertyRequest {
  property_name: string
  value: unknown
  /** Optional ramp duration in ms. Honoured for volume and mute transitions.
   *  Values > 50 ms use a 12-point dB-linear curve for even-sounding fades. */
  ramp_ms?: number
}

export interface UpdatePadPropertyRequest {
  property_name: string
  value: unknown
}

// --- Media player ---

export type PlayerAction = 'play' | 'pause' | 'stop' | 'next' | 'previous'

export interface PlayerControlRequest {
  action: PlayerAction
}

export interface PlayerStateResponse {
  state: 'playing' | 'paused' | 'stopped'
  current_file?: string
  position_ms?: number
  duration_ms?: number
  playlist?: string[]
}

export interface SetPlaylistRequest {
  files: string[]
}

export interface SeekRequest {
  position_ms: number
}

export interface GotoRequest {
  index: number
}

// --- Stats / debug ---

export interface FlowDebugInfo {
  base_time?: number
  clock_time?: number
  running_time?: number
}

export interface FlowStatsResponse {
  stats: Record<string, unknown>
}

export interface WebRtcStatsResponse {
  stats: Record<string, unknown>
}

export interface LatencyResponse {
  min_latency_ns?: number
  max_latency_ns?: number
}

export interface DynamicPadsResponse {
  pads: Array<{ element: string; pad: string; caps?: string }>
}

export interface MultiviewEndpointResponse {
  endpoint: string
}

// --- Probes ---

export interface ActivateProbeRequest {
  element_id: string
  pad_name: string
}

export interface ProbeResponse {
  probe_id: string
}

export interface ActiveProbesResponse {
  probes: Array<{ probe_id: string; element_id: string; pad_name: string }>
}

// --- Discovery ---

export interface DeviceResponse {
  id: string
  name: string
  category?: string
  address?: string
}

export interface DeviceDiscoveryStatus {
  scanning: boolean
  last_scan?: string
}

export interface NdiDiscoveryStatus {
  scanning: boolean
  last_scan?: string
}

export interface DiscoveredStreamResponse {
  id: string
  name: string
  address?: string
  sdp?: string
}

export interface AnnouncedStreamResponse {
  id: string
  name: string
  address?: string
}

// --- gst-launch ---

export interface ParseGstLaunchRequest {
  pipeline: string
}

export interface ParseGstLaunchResponse {
  elements: FlowElement[]
  links: FlowLink[]
}

export interface ExportGstLaunchRequest {
  elements: FlowElement[]
  links: FlowLink[]
}

export interface ExportGstLaunchResponse {
  pipeline: string
}

// --- Media ---

export interface MediaEntry {
  name: string
  path: string
  is_dir: boolean
  size?: number
  modified?: string
}

export interface ListMediaResponse {
  entries: MediaEntry[]
}

export interface MediaOperationResponse {
  success: boolean
  message?: string
}

export interface CreateDirectoryRequest {
  path: string
}

export interface RenameMediaRequest {
  path: string
  new_name: string
}

// --- Network ---

export interface NetworkInterface {
  name: string
  mac?: string
  addresses: string[]
}

export interface NetworkInterfacesResponse {
  interfaces: NetworkInterface[]
}

// --- Sources ---

export interface AvailableSource {
  flow_id: string
  flow_name: string
  output_id: string
  active: boolean
}

export interface AvailableSourcesResponse {
  sources: AvailableSource[]
}

// --- ICE / WebRTC ---

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface IceServersResponse {
  ice_servers: IceServer[]
}

// --- Port leases ---

/** A range of SRT listener ports reserved for one client on a shared Strom instance. */
export interface PortLease {
  id: string
  client_id: string
  first_port: number
  last_port: number
  /** RFC 3339 timestamp */
  created_at: string
  /** RFC 3339 timestamp */
  expires_at: string
}

export interface AcquirePortLeaseRequest {
  client_id: string
  size: number
  ttl_secs?: number
}

export interface RenewPortLeaseRequest {
  ttl_secs?: number
}

export interface WhepStreamsResponse {
  streams: Array<{ endpoint_id: string; mode: string; has_audio: boolean; has_video: boolean }>
}

// --- WebSocket events ---

export type FlowEvent =
  | { type: 'flow_created'; flow: Flow }
  | { type: 'flow_updated'; flow: Flow }
  | { type: 'flow_deleted'; flow_id: string }
  | { type: 'flow_started'; flow_id: string }
  | { type: 'flow_stopped'; flow_id: string }
  | { type: 'MeterData'; data: { flow_id: string; element_id: string; rms: number[]; peak: number[]; decay: number[] } }
  | { type: 'LoudnessData'; data: { flow_id: string; element_id: string; momentary: number; shortterm: number | null; integrated: number | null; loudness_range: number | null; true_peak: number[] } }
  | { type: 'ping' }

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class StromClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Strom API error ${status}: ${message}`)
    this.name = 'StromClientError'
  }
}

export interface StromClientOptions {
  baseUrl: string
  /** Optional Bearer token — API key or SAT for OSC-hosted instances */
  token?: string
}

export class StromClient {
  private readonly baseUrl: string
  private token: string | undefined

  constructor(options: StromClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.token = options.token
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    // Retry once on UND_ERR_SOCKET: undici doesn't auto-retry unsafe methods (PATCH/POST)
    // when a pooled connection was closed by the server. The stale connection is evicted on
    // the first failure, so the retry always opens a fresh TCP connection.
    let res: Response
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        res = await fetch(url, {
          method,
          headers: this.headers(),
          body: body !== undefined
            // JSON.stringify serialises 10.0 as "10" (integer) — Python's json.loads
            // then parses it as int, which Strom rejects for float fields like volume.
            // Force a decimal point on any bare-integer "value" field so the backend
            // always receives a JSON number with a fractional part.
            ? JSON.stringify(body).replace(/"value":(-?\d+)([,}])/g, '"value":$1.0$2')
            : undefined,
        })
        break
      } catch (err) {
        const e = err as Error & { cause?: Error & { code?: string } }
        if (attempt === 0 && e.cause?.code === 'UND_ERR_SOCKET') {
          // Strom closed the pooled connection. undici evicts the stale socket on the
          // first failure, so the immediate retry opens a fresh TCP connection — no
          // sleep needed (sleeping gave Strom time to close the fresh socket too).
          continue
        }
        const cause = e.cause ? ` [cause: ${e.cause.message ?? String(e.cause)}${e.cause.code ? ` code=${e.cause.code}` : ''}]` : ''
        throw new StromClientError(0, `Strom unreachable: ${e.message}${cause} — ${method} ${url}`)
      }
    }
    res = res!

    if (res.status === 204) return undefined as T

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      const text = await res.text()
      throw new StromClientError(
        res.status,
        `Strom returned non-JSON response (${res.status}): ${text.slice(0, 120)}`,
      )
    }

    const json = await res.json() as (StromError & { details?: string })
    if (!res.ok) {
      const msg = [json.error, json.details].filter(Boolean).join(' — ')
      throw new StromClientError(res.status, msg || res.statusText)
    }
    return json as T
  }

  private get = <T>(path: string) => this.request<T>('GET', path)
  private post = <T>(path: string, body?: unknown) => this.request<T>('POST', path, body)
  private put = <T>(path: string, body: unknown) => this.request<T>('PUT', path, body)
  private del = <T>(path: string) => this.request<T>('DELETE', path)
  private patch = <T>(path: string, body: unknown) => this.request<T>('PATCH', path, body)

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  auth = {
    status: () => this.get<AuthStatusResponse>('/api/auth/status'),
    login: (body: LoginRequest) => this.post<LoginResponse>('/api/login', body),
    logout: () => this.post<LoginResponse>('/api/logout'),
  }

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  system = {
    version: () => this.get<SystemInfo>('/api/version'),
    iceServers: () => this.get<IceServersResponse>('/api/ice-servers'),
    networkInterfaces: () => this.get<NetworkInterfacesResponse>('/api/network/interfaces'),
  }

  // -------------------------------------------------------------------------
  // Port leases
  // -------------------------------------------------------------------------

  portLeases = {
    list: () => this.get<PortLease[]>('/api/port-leases'),
    get: (id: string) => this.get<PortLease>(`/api/port-leases/${id}`),
    /** Idempotent on client_id: returns the existing (renewed) lease if one is held. */
    acquire: (body: AcquirePortLeaseRequest) => this.post<PortLease>('/api/port-leases', body),
    renew: (id: string, body: RenewPortLeaseRequest = {}) =>
      this.post<PortLease>(`/api/port-leases/${id}/renew`, body),
    release: (id: string) => this.del<void>(`/api/port-leases/${id}`),
  }

  // -------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------

  blocks = {
    list: () => this.get<BlockListResponse>('/api/blocks'),
    categories: () => this.get<BlockCategoriesResponse>('/api/blocks/categories'),
    get: (id: string) => this.get<BlockResponse>(`/api/blocks/${id}`),
    create: (body: CreateBlockRequest) => this.post<BlockResponse>('/api/blocks', body),
    update: (id: string, body: BlockDefinition) => this.put<BlockResponse>(`/api/blocks/${id}`, body),
    delete: (id: string) => this.del<void>(`/api/blocks/${id}`),
  }

  // -------------------------------------------------------------------------
  // Elements (GStreamer)
  // -------------------------------------------------------------------------

  elements = {
    list: () => this.get<ElementListResponse>('/api/elements'),
    get: (name: string) => this.get<ElementInfoResponse>(`/api/elements/${name}`),
    pads: (name: string) => this.get<ElementInfoResponse>(`/api/elements/${name}/pads`),
  }

  // -------------------------------------------------------------------------
  // Flows
  // -------------------------------------------------------------------------

  flows = {
    list: () => this.get<FlowListResponse>('/api/flows'),
    get: (id: string) => this.get<FlowResponse>(`/api/flows/${id}`),
    create: (body: CreateFlowRequest) => this.post<FlowResponse>('/api/flows', body),
    update: (id: string, body: Flow) => this.put<FlowResponse>(`/api/flows/${id}`, body),
    delete: (id: string) => this.del<void>(`/api/flows/${id}`),
    start: (id: string) => this.post<FlowResponse>(`/api/flows/${id}/start`),
    stop: (id: string) => this.post<FlowResponse>(`/api/flows/${id}/stop`),
    updateProperties: (id: string, body: UpdateFlowPropertiesRequest) =>
      this.patch<FlowResponse>(`/api/flows/${id}/properties`, body),
    debug: (id: string) => this.get<FlowDebugInfo>(`/api/flows/${id}/debug`),
    debugGraph: (id: string) => this.get<string>(`/api/flows/${id}/debug-graph`),
    dynamicPads: (id: string) => this.get<DynamicPadsResponse>(`/api/flows/${id}/dynamic-pads`),
    latency: (id: string) => this.get<LatencyResponse>(`/api/flows/${id}/latency`),
    rtpStats: (id: string) => this.get<FlowStatsResponse>(`/api/flows/${id}/rtp-stats`),
    webrtcStats: (id: string) => this.get<WebRtcStatsResponse>(`/api/flows/${id}/webrtc-stats`),
    padCaps: (id: string) => this.get<Record<string, unknown>>(`/api/flows/${id}/pad-caps`),
    thumbnail: (id: string, blockId: string, index?: number) => {
      const q = index !== undefined ? `?index=${index}` : ''
      return `${this.baseUrl}/api/flows/${id}/blocks/${blockId}/thumbnail${q}`
    },
    getBlockProperties: (flowId: string, blockId: string) =>
      this.get<BlockPropertiesResponse>(`/api/flows/${flowId}/blocks/${blockId}/properties`),
    updateBlockProperties: (flowId: string, blockId: string, body: UpdateBlockPropertiesRequest) =>
      this.patch<BlockPropertiesResponse>(`/api/flows/${flowId}/blocks/${blockId}/properties`, body),
  }

  // -------------------------------------------------------------------------
  // Flow — block operations
  // -------------------------------------------------------------------------

  mixer = {
    transition: (flowId: string, blockId: string, body: TriggerTransitionRequest) =>
      this.post<TransitionResponse>(`/api/flows/${flowId}/blocks/${blockId}/transition`, body),

    /**
     * Select a preview source on the vision mixer.
     * PUT (confirmed against origin/main lib.rs — changed from POST in 0.4.x).
     * Body: { input: 0-based index, multi?: boolean }
     */
    selectPreview: (flowId: string, blockId: string, body: SelectPreviewRequest) =>
      this.put<SelectPreviewResponse>(`/api/flows/${flowId}/blocks/${blockId}/preview`, body),

    toggleDsk: (flowId: string, blockId: string, body: DskToggleRequest) =>
      this.post<DskToggleResponse>(`/api/flows/${flowId}/blocks/${blockId}/dsk`, body),

    fadeToBlack: (flowId: string, blockId: string, body: FadeToBlackRequest) =>
      this.post<FadeToBlackResponse>(`/api/flows/${flowId}/blocks/${blockId}/ftb`, body),

    animateInput: (flowId: string, blockId: string, body: AnimateInputRequest) =>
      this.post<void>(`/api/flows/${flowId}/blocks/${blockId}/animate`, body),

    setOverlayAlpha: (flowId: string, blockId: string, body: OverlayAlphaRequest) =>
      this.put<OverlayAlphaResponse>(`/api/flows/${flowId}/blocks/${blockId}/overlay-alpha`, body),

    updatePipConfig: (flowId: string, blockId: string, pipIdx: number, body: UpdatePipConfigRequest) =>
      this.put<UpdatePipConfigResponse>(`/api/flows/${flowId}/blocks/${blockId}/pip/${pipIdx}`, body),

    multiviewEndpoint: (flowId: string, blockId: string) =>
      this.get<MultiviewEndpointResponse>(`/api/flows/${flowId}/blocks/${blockId}/multiview-endpoint`),

    getState: (flowId: string, blockId: string) =>
      this.get<VisionMixerStateResponse>(`/api/flows/${flowId}/blocks/${blockId}/state`),

    setVideoEffect: (flowId: string, blockId: string, body: SetVideoEffectRequest) =>
      this.post<SetVideoEffectResponse>(`/api/flows/${flowId}/blocks/${blockId}/effect`, body),

    getPipState: (flowId: string, blockId: string, pipIdx: number) =>
      this.get<StromPipState>(`/api/flows/${flowId}/blocks/${blockId}/pip/${pipIdx}`),
  }

  // -------------------------------------------------------------------------
  // Flow — element/pad properties (live control)
  // -------------------------------------------------------------------------

  properties = {
    getElement: (flowId: string, elementId: string) =>
      this.get<ElementPropertiesResponse>(`/api/flows/${flowId}/elements/${elementId}/properties`),

    updateElement: (flowId: string, elementId: string, body: UpdatePropertyRequest) =>
      this.patch<ElementPropertiesResponse>(`/api/flows/${flowId}/elements/${elementId}/properties`, body),

    getPad: (flowId: string, elementId: string, padName: string) =>
      this.get<PadPropertiesResponse>(
        `/api/flows/${flowId}/elements/${elementId}/pads/${padName}/properties`,
      ),

    updatePad: (flowId: string, elementId: string, padName: string, body: UpdatePadPropertyRequest) =>
      this.patch<PadPropertiesResponse>(
        `/api/flows/${flowId}/elements/${elementId}/pads/${padName}/properties`,
        body,
      ),
  }

  // -------------------------------------------------------------------------
  // Flow — media player
  // -------------------------------------------------------------------------

  player = {
    getState: (flowId: string, blockId: string) =>
      this.get<PlayerStateResponse>(`/api/flows/${flowId}/blocks/${blockId}/player/state`),

    control: (flowId: string, blockId: string, body: PlayerControlRequest) =>
      this.post<void>(`/api/flows/${flowId}/blocks/${blockId}/player/control`, body),

    setPlaylist: (flowId: string, blockId: string, body: SetPlaylistRequest) =>
      this.post<void>(`/api/flows/${flowId}/blocks/${blockId}/player/playlist`, body),

    seek: (flowId: string, blockId: string, body: SeekRequest) =>
      this.post<void>(`/api/flows/${flowId}/blocks/${blockId}/player/seek`, body),

    goto: (flowId: string, blockId: string, body: GotoRequest) =>
      this.post<void>(`/api/flows/${flowId}/blocks/${blockId}/player/goto`, body),
  }

  // -------------------------------------------------------------------------
  // Flow — recorder
  // -------------------------------------------------------------------------

  recorder = {
    splitNow: (flowId: string, blockId: string) =>
      this.post<void>(`/api/flows/${flowId}/blocks/${blockId}/recorder/split`),
  }

  // -------------------------------------------------------------------------
  // Flow — loudness / SDP
  // -------------------------------------------------------------------------

  loudness = {
    reset: (flowId: string, blockId: string) =>
      this.post<void>(`/api/flows/${flowId}/blocks/${blockId}/loudness/reset`),
  }

  sdp = {
    getBlock: (flowId: string, blockId: string) =>
      this.get<string>(`/api/flows/${flowId}/blocks/${blockId}/sdp`),
  }

  // -------------------------------------------------------------------------
  // Probes
  // -------------------------------------------------------------------------

  probes = {
    list: (flowId: string) => this.get<ActiveProbesResponse>(`/api/flows/${flowId}/probes`),
    activate: (flowId: string, body: ActivateProbeRequest) =>
      this.post<ProbeResponse>(`/api/flows/${flowId}/probes`, body),
    deactivate: (flowId: string, probeId: string) =>
      this.del<void>(`/api/flows/${flowId}/probes/${probeId}`),
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  discovery = {
    listDevices: (category?: string) => {
      const q = category ? `?category=${encodeURIComponent(category)}` : ''
      return this.get<DeviceResponse[]>(`/api/discovery/devices${q}`)
    },
    getDevice: (id: string) => this.get<DeviceResponse>(`/api/discovery/devices/${id}`),
    refreshDevices: () => this.post<void>('/api/discovery/devices/refresh'),
    deviceStatus: () => this.get<DeviceDiscoveryStatus>('/api/discovery/devices/status'),
    listNdiSources: () => this.get<DeviceResponse[]>('/api/discovery/ndi/sources'),
    refreshNdi: () => this.post<void>('/api/discovery/ndi/refresh'),
    ndiStatus: () => this.get<NdiDiscoveryStatus>('/api/discovery/ndi/status'),
    listStreams: () => this.get<DiscoveredStreamResponse[]>('/api/discovery/streams'),
    getStream: (id: string) => this.get<DiscoveredStreamResponse>(`/api/discovery/streams/${id}`),
    getStreamSdp: (id: string) => this.get<string>(`/api/discovery/streams/${id}/sdp`),
    listAnnounced: () => this.get<AnnouncedStreamResponse[]>('/api/discovery/announced'),
  }

  // -------------------------------------------------------------------------
  // gst-launch
  // -------------------------------------------------------------------------

  gstLaunch = {
    parse: (body: ParseGstLaunchRequest) =>
      this.post<ParseGstLaunchResponse>('/api/gst-launch/parse', body),
    export: (body: ExportGstLaunchRequest) =>
      this.post<ExportGstLaunchResponse>('/api/gst-launch/export', body),
  }

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  media = {
    list: (path?: string) => {
      const q = path ? `?path=${encodeURIComponent(path)}` : ''
      return this.get<ListMediaResponse>(`/api/media${q}`)
    },
    createDirectory: (body: CreateDirectoryRequest) =>
      this.post<MediaOperationResponse>('/api/media/directory', body),
    deleteDirectory: (path: string) =>
      this.del<MediaOperationResponse>(`/api/media/directory/${encodeURIComponent(path)}`),
    downloadFile: (path: string) =>
      this.get<unknown>(`/api/media/file/${encodeURIComponent(path)}`),
    deleteFile: (path: string) =>
      this.del<MediaOperationResponse>(`/api/media/file/${encodeURIComponent(path)}`),
    rename: (body: RenameMediaRequest) =>
      this.post<MediaOperationResponse>('/api/media/rename', body),
  }

  // -------------------------------------------------------------------------
  // Available sources
  // -------------------------------------------------------------------------

  sources = {
    list: () => this.get<AvailableSourcesResponse>('/api/sources'),
  }

  // -------------------------------------------------------------------------
  // WHEP / WHIP
  // -------------------------------------------------------------------------

  whep = {
    listStreams: () => this.get<WhepStreamsResponse>('/api/whep-streams'),
  }

  // -------------------------------------------------------------------------
  // WebSocket — real-time flow events
  // -------------------------------------------------------------------------

  /**
   * Opens a WebSocket connection to /api/ws and calls `onEvent` for each
   * flow event. Returns a cleanup function that closes the socket.
   */
  connectWebSocket(onEvent: (event: FlowEvent) => void, onClose?: () => void): () => void {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/ws'
    const headers: Record<string, string> = {}
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    const ws = new WsWebSocket(wsUrl, { headers })

    ws.on('error', (err) => {
      console.error('[strom-ws] Connection error:', err.message)
    })

    ws.on('close', (_code, _reason) => {
      onClose?.()
    })

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as FlowEvent
        onEvent(event)
      } catch {
        // ignore malformed frames
      }
    })

    return () => ws.close()
  }
}
