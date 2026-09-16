/**
 * REST clip cue/play/stop/state endpoints (epic #206, issue #277).
 *
 *   POST /api/v1/productions/:id/clips/:mixerInput/cue   body { clipId? } → 200 ClipState
 *   POST /api/v1/productions/:id/clips/:mixerInput/play                   → 200 ClipState
 *   POST /api/v1/productions/:id/clips/:mixerInput/stop                   → 200 ClipState
 *   GET  /api/v1/productions/:id/clips/:mixerInput/state                  → 200 ClipState
 *
 * All shared clip-control logic (resolve production → flowId + player block,
 * drive the Strom media-player block, map to ClipState) lives in
 * `src/lib/clip-control.ts` so the WS CLIP_* commands (#278) reuse it.
 *
 * Error codes (spec §"Error codes"):
 *   400 invalid body/param (zod), 401 missing/invalid API_KEY (central hook),
 *   404 production or clip source not found, 409 production not activated /
 *   no clip cued on play, 502/503 Strom unreachable.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb, getSourcesDb } from '../db/index.js';
import type { ProductionDoc } from '../db/types.js';
import { StromClient, StromClientError } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';
import {
  cueClip,
  playClip,
  stopClip,
  getClipState,
  resolveClipSource,
  ClipNotFoundError,
  ClipNotActivatedError,
  ClipNotCuedError,
} from '../lib/clip-control.js';
import { setClipStateEntry, getClipStateEntry } from '../services/clip-state.service.js';

// mixerInput path param — same shape as the WS mixerInputSchema.
const mixerInputSchema = z.string().regex(/^video_in_\d{1,2}$/).max(20);
const CueBody = z.object({ clipId: z.string().min(1).max(256).optional() }).strict();

async function makeStromClient(): Promise<StromClient> {
  const token = await getStromToken(config.stromToken);
  return new StromClient({ baseUrl: config.stromUrl, token });
}

/**
 * Maps a StromClientError to the spec's transport error codes: status 0 (the
 * client's "unreachable" sentinel) → 503; any other Strom HTTP failure → 502.
 * Carries `statusCode` so the central error handler surfaces it correctly.
 */
function stromTransportError(err: StromClientError): Error & { statusCode: number } {
  const statusCode = err.status === 0 ? 503 : 502;
  const wrapped = new Error(
    statusCode === 503 ? 'Strom is unreachable' : `Strom error: ${err.message}`,
  ) as Error & { statusCode: number };
  wrapped.statusCode = statusCode;
  return wrapped;
}

const clipsRoutes: FastifyPluginAsync = async (fastify) => {
  /** Loads the production doc or throws a 404-carrying error. */
  async function loadProduction(id: string): Promise<ProductionDoc> {
    try {
      return await getDb().get(id);
    } catch {
      const err = new Error('Production not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
  }

  const loadSource = (sourceId: string) => getSourcesDb().get(sourceId);

  // POST …/cue — cue a clip into the ready state.
  fastify.post<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/clips/:mixerInput/cue',
    async (req, reply) => {
      const mixerInput = mixerInputSchema.parse(req.params.mixerInput);
      const body = CueBody.parse(req.body ?? {});
      const doc = await loadProduction(req.params.id);
      try {
        const source = await resolveClipSource(doc, mixerInput, loadSource);
        const strom = await makeStromClient();
        const state = await cueClip(strom, doc, source, mixerInput, body.clipId);
        setClipStateEntry(doc._id, state);
        return reply.send(state);
      } catch (err) {
        return handleClipError(err, reply);
      }
    },
  );

  // POST …/play — play the currently cued clip.
  fastify.post<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/clips/:mixerInput/play',
    async (req, reply) => {
      const mixerInput = mixerInputSchema.parse(req.params.mixerInput);
      const doc = await loadProduction(req.params.id);
      try {
        // Guard: reject play when nothing has been cued for this input (409).
        // "cued" is tracked in the in-memory registry (a fresh player that was
        // never cued reports raw `stopped`, which is not a cue). A prior cue /
        // play / paused / completed entry means a clip is loaded and playable.
        const source = await resolveClipSource(doc, mixerInput, loadSource);
        const tracked = getClipStateEntry(doc._id, mixerInput);
        if (!tracked || tracked.state === 'idle') throw new ClipNotCuedError();
        const strom = await makeStromClient();
        const state = await playClip(strom, doc, mixerInput, source._id);
        setClipStateEntry(doc._id, state);
        return reply.send(state);
      } catch (err) {
        return handleClipError(err, reply);
      }
    },
  );

  // POST …/stop — stop playback.
  fastify.post<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/clips/:mixerInput/stop',
    async (req, reply) => {
      const mixerInput = mixerInputSchema.parse(req.params.mixerInput);
      const doc = await loadProduction(req.params.id);
      try {
        const source = await resolveClipSource(doc, mixerInput, loadSource);
        const strom = await makeStromClient();
        const state = await stopClip(strom, doc, mixerInput, source._id);
        setClipStateEntry(doc._id, state);
        return reply.send(state);
      } catch (err) {
        return handleClipError(err, reply);
      }
    },
  );

  // GET …/state — current clip state.
  fastify.get<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/clips/:mixerInput/state',
    async (req, reply) => {
      const mixerInput = mixerInputSchema.parse(req.params.mixerInput);
      const doc = await loadProduction(req.params.id);
      try {
        const source = await resolveClipSource(doc, mixerInput, loadSource);
        const strom = await makeStromClient();
        const state = await getClipState(strom, doc, mixerInput, source._id);
        setClipStateEntry(doc._id, state);
        return reply.send(state);
      } catch (err) {
        return handleClipError(err, reply);
      }
    },
  );
};

/**
 * Maps a clip-control error to an HTTP response.
 * - typed clip errors carry their own statusCode (404 / 409 / 501) — rethrow to
 *   the central error handler, which formats `{ error, statusCode }`.
 * - StromClientError → 502/503 via {@link stromTransportError}.
 * - anything else propagates (→ 500).
 */
function handleClipError(err: unknown, _reply: unknown): never {
  if (err instanceof StromClientError) throw stromTransportError(err);
  if (
    err instanceof ClipNotFoundError ||
    err instanceof ClipNotActivatedError ||
    err instanceof ClipNotCuedError
  ) {
    throw err; // statusCode already set (404 / 409)
  }
  // ClipReferenceNotImplementedError (501) and any other error with a statusCode
  // propagate to the central handler unchanged.
  throw err;
}

export default clipsRoutes;
