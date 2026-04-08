/**
 * Strom API client — generated from openapi.json v0.4.5
 * https://github.com/Eyevinn/strom
 */

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

export interface Flow {
  id: string
  name: string
  description?: string
  running?: boolean
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
export interface CreateFlowRequest {
  id: string
  name: string
  description?: string
  elements?: FlowElement[]
  blocks?: BlockInstance[]
  links?: FlowLink[]
}

export interface UpdateFlowPropertiesRequest {
  description?: string
  clock_type?: string
}

// --- Flow operations ---

export type TransitionType = 'cut' | 'fade' | 'slide_left' | 'slide_right' | 'slide_up' | 'slide_down'

export interface TriggerTransitionRequest {
  from_input: string
  to_input: string
  transition_type: TransitionType
  duration_ms?: number
}

export interface TransitionResponse {
  success: boolean
}

export interface SelectPreviewRequest {
  input: string
}

export interface SelectPreviewResponse {
  input: string
}

export interface AnimateInputRequest {
  input: string
  x?: number
  y?: number
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
  layer: number
  visible?: boolean
}

export interface DskToggleResponse {
  layer: number
  visible: boolean
}

export interface FadeToBlackRequest {
  active?: boolean
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
  property: string
  value: unknown
}

export interface UpdatePadPropertyRequest {
  property: string
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
  url: string
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

export interface WhepStreamsResponse {
  streams: Array<{ id: string; url: string }>
}

// --- WebSocket events ---

export type FlowEvent =
  | { type: 'flow_created'; flow: Flow }
  | { type: 'flow_updated'; flow: Flow }
  | { type: 'flow_deleted'; flow_id: string }
  | { type: 'flow_started'; flow_id: string }
  | { type: 'flow_stopped'; flow_id: string }
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
  /** Optional Bearer token or session cookie — if omitted, assumes no-auth mode */
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
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 204) return undefined as T
    const json = await res.json()
    if (!res.ok) throw new StromClientError(res.status, (json as StromError).error ?? res.statusText)
    return json as T
  }

  private get = <T>(path: string) => this.request<T>('GET', path)
  private post = <T>(path: string, body?: unknown) => this.request<T>('POST', path, body)
  private put = <T>(path: string, body: unknown) => this.request<T>('PUT', path, body)
  private patch = <T>(path: string, body: unknown) => this.request<T>('PATCH', path, body)
  private del = <T>(path: string) => this.request<T>('DELETE', path)

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
  }

  // -------------------------------------------------------------------------
  // Flow — block operations
  // -------------------------------------------------------------------------

  mixer = {
    transition: (flowId: string, blockId: string, body: TriggerTransitionRequest) =>
      this.post<TransitionResponse>(`/api/flows/${flowId}/blocks/${blockId}/transition`, body),

    selectPreview: (flowId: string, blockId: string, body: SelectPreviewRequest) =>
      this.post<SelectPreviewResponse>(`/api/flows/${flowId}/blocks/${blockId}/preview`, body),

    setBackground: (flowId: string, blockId: string, body: SetBackgroundRequest) =>
      this.post<SetBackgroundResponse>(`/api/flows/${flowId}/blocks/${blockId}/background`, body),

    toggleDsk: (flowId: string, blockId: string, body: DskToggleRequest) =>
      this.post<DskToggleResponse>(`/api/flows/${flowId}/blocks/${blockId}/dsk`, body),

    fadeToBlack: (flowId: string, blockId: string, body: FadeToBlackRequest) =>
      this.post<FadeToBlackResponse>(`/api/flows/${flowId}/blocks/${blockId}/ftb`, body),

    animateInput: (flowId: string, blockId: string, body: AnimateInputRequest) =>
      this.post<void>(`/api/flows/${flowId}/blocks/${blockId}/animate`, body),

    setOverlayAlpha: (flowId: string, blockId: string, body: OverlayAlphaRequest) =>
      this.post<OverlayAlphaResponse>(`/api/flows/${flowId}/blocks/${blockId}/overlay-alpha`, body),

    multiviewEndpoint: (flowId: string, blockId: string) =>
      this.get<MultiviewEndpointResponse>(`/api/flows/${flowId}/blocks/${blockId}/multiview-endpoint`),
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
  connectWebSocket(onEvent: (event: FlowEvent) => void): () => void {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/ws'
    const ws = new WebSocket(wsUrl)

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as FlowEvent
        onEvent(event)
      } catch {
        // ignore malformed frames
      }
    }

    return () => ws.close()
  }
}
