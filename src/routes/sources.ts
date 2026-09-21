import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getSourcesDb, getGatewaysDb, getDb } from '../db/index.js';
import type { SourceDoc, ProductionDoc, HtmlSourceAuth } from '../db/types.js';
import { updateProductionDoc } from './productions.js';
import { graphicUrl, srtUrl } from '../lib/url-validation.js';
import { deserializeClipReference } from '../lib/clip-reference.js';
import { encryptAddressPassphrase, decryptAddressPassphrase } from '../lib/srt-passphrase-crypto.js';
import { encryptHtmlAuthValue } from '../lib/html-auth-crypto.js';
import { getPortLease } from '../services/port-lease.js';
import { clashesAfterWrite, listenerPortRequest, resolveListenerAddress, usedListenerPorts } from '../services/listener-ports.js';

/**
 * Token-header name allowlist for a Design-B auth header (issue #314,
 * `docs/specs/authenticated-html-sources.md` §API Design / Error codes). RFC
 * 7230 token chars only, bounded length — rejects header injection (CR/LF,
 * spaces) and absurdly long names. The credential VALUE is bounded separately.
 */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
/** Upper bound on a stored header credential value (spec: "over length" → 400). */
const HEADER_VALUE_MAX = 8192;

/**
 * Zod schema for the API-facing `auth` object accepted on create/patch of an
 * HTML source. `header.value` is write-only (accepted here, never echoed);
 * `header.valueSet` and `profile.*` are server-managed and rejected on input so
 * a client cannot spoof "a value is stored" or forge a profile status.
 */
const HtmlSourceAuthInput = z.object({
  mode: z.enum(['header', 'profile']),
  header: z
    .object({
      name: z.string().regex(HEADER_NAME_RE, 'Invalid header name'),
      // write-only: accepted, encrypted, never returned. Empty string clears it.
      value: z.string().max(HEADER_VALUE_MAX).optional(),
    })
    .strict()
    .optional(),
  // profile is server-issued; a client may not set profileId/status/timestamps.
  profile: z
    .object({})
    .strict()
    .optional(),
}).strict();

/**
 * Cross-field validation for a source's `address` given its effective
 * `streamType`. Adds a zod issue on `['address']` on failure. Shared by the
 * create and patch schemas so all stream types (including `clip`) validate
 * identically.
 *
 * `clip` sources store a serialized `ClipReference` (JSON) in `address`; it is
 * deserialized, shape-validated and semantically validated here (url → SSRF
 * checks, s3 → bucket/key, tams → 501/not-implemented) — no persisted schema
 * change (issue #275, spec: clip-story-playback.md §"Migration").
 */
function validateSourceAddress(
  streamType: string,
  address: string,
  ctx: z.RefinementCtx,
): void {
  if (streamType === 'html') {
    // html sources use a browser URL — validate for SSRF (file://, javascript:, private IPs, etc.)
    try {
      graphicUrl(address);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: err instanceof Error ? err.message : 'Invalid HTML source URL' });
    }
  } else if (streamType === 'srt' || streamType === 'efp') {
    // SRT/EFP sources: must be a valid srt:// URI pointing to a non-private host
    try {
      srtUrl(address);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: err instanceof Error ? err.message : 'Invalid SRT source address' });
    }
  } else if (streamType === 'clip') {
    // clip sources carry a serialized typed ClipReference (url/s3/tams) as JSON.
    try {
      deserializeClipReference(address);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: err instanceof Error ? err.message : 'Invalid clip reference' });
    }
  }
}

/**
 * Cross-field validation for an `auth` object on a source. Adds a zod issue on
 * `['auth']` on failure. Enforces (spec §Error codes):
 *  - `auth` only on an `html` source;
 *  - mode/shape consistency (`header` mode carries a `header`, not a `profile`,
 *    and vice-versa).
 * Header-name/value length are already enforced by {@link HtmlSourceAuthInput}.
 */
function validateSourceAuth(
  streamType: string,
  auth: z.infer<typeof HtmlSourceAuthInput> | undefined,
  ctx: z.RefinementCtx,
): void {
  if (auth === undefined) return;
  if (streamType !== 'html') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['auth'], message: 'auth is only valid on an html source' });
    return;
  }
  if (auth.mode === 'header') {
    if (auth.profile !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['auth'], message: 'header-mode auth must not carry a profile' });
    }
    if (auth.header === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['auth'], message: 'header-mode auth requires a header' });
    }
  } else if (auth.mode === 'profile') {
    if (auth.header !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['auth'], message: 'profile-mode auth must not carry a header' });
    }
  }
}

const SourceInput = z.object({
  name: z.string().min(1).max(256),
  address: z.string(),
  streamType: z.enum(['srt', 'efp', 'whip', 'html', 'clip']),
  status: z.enum(['active', 'inactive']).default('inactive'),
  liveCamera: z.boolean().optional(),
  latency: z.number().int().min(20).max(8000).optional(),
  // Optional id of the Gateway that registered this source (OL-5, spec
  // studio-gateways.md). Absent for manually-created sources; when present it
  // must name an existing gateway (validated in the route handler).
  gatewayId: z.string().optional(),
  // Authenticated-HTML-source auth material (issue #314). Only valid for html.
  auth: HtmlSourceAuthInput.optional(),
}).superRefine((data, ctx) => {
  validateSourceAddress(data.streamType, data.address, ctx);
  validateSourceAuth(data.streamType, data.auth, ctx);
});

const SourcePatch = z.object({
  name: z.string().min(1).max(256).optional(),
  address: z.string().optional(),
  streamType: z.enum(['srt', 'efp', 'whip', 'html', 'clip']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  liveCamera: z.boolean().optional(),
  latency: z.number().int().min(20).max(8000).optional(),
  // A gateway can re-tag or clear a source's gateway link. `null` clears the
  // link (unlinks the source); a string re-links it to an (existing) gateway.
  gatewayId: z.string().nullable().optional(),
  // Set/replace/clear auth on an HTML source. `null` clears it entirely.
  auth: HtmlSourceAuthInput.nullable().optional(),
}).superRefine((data, ctx) => {
  // Cross-field validation only applies when both address and streamType are present in
  // the same patch body. The combined-with-existing-document case is validated procedurally
  // in the route handler, which has access to the stored source document.
  if (data.address === undefined || data.streamType === undefined) {
    return;
  }
  validateSourceAddress(data.streamType, data.address, ctx);
});

/** Masks passphrase values in SRT URIs so credentials are never returned to clients. */
function maskSrtPassphrase(address: string): string {
  return address.replace(/([?&]passphrase=)[^&]*/gi, '$1***');
}

/**
 * Confirms `gatewayId` names an existing gateway. A typo would otherwise create
 * an unreachable link (the forget-gateway cascade would never find the source),
 * so an unknown id is rejected with 400. Looks the gateway up the same way the
 * gateways route does (`getGatewaysDb().get`, `src/routes/gateways.ts`).
 * Returns true when the gateway exists, false on a 404, and rethrows other DB
 * errors so they surface as a 503 like elsewhere in this module.
 */
/**
 * Translate the validated API `auth` input into the stored representation:
 *  - header mode → store `auth.header.name` and, when a value is supplied,
 *    encrypt it onto `authHeaderValueEnc` (bound to `sourceId` via GCM AAD). An
 *    empty-string value clears the stored secret. When `value` is omitted the
 *    existing ciphertext (`prevEnc`) is preserved so a header-name-only patch
 *    does not wipe the credential.
 *  - profile mode → server-issue a `profileId` and start `status:
 *    'unprovisioned'`, preserving an existing profile when one is present.
 * Returns the stored `auth` object and the (possibly updated) ciphertext.
 * Never logs the plaintext.
 */
function buildStoredAuth(
  input: z.infer<typeof HtmlSourceAuthInput>,
  sourceId: string,
  prev: { auth?: HtmlSourceAuth; enc?: string },
): { auth: HtmlSourceAuth; enc: string | undefined } {
  if (input.mode === 'header') {
    let enc = prev.enc;
    if (input.header?.value !== undefined) {
      enc = input.header.value === '' ? undefined : encryptHtmlAuthValue(input.header.value, sourceId);
    }
    return { auth: { mode: 'header', header: { name: input.header!.name } }, enc };
  }
  // profile mode: preserve an existing profile, else issue a fresh one.
  const existing = prev.auth?.mode === 'profile' ? prev.auth.profile : undefined;
  const profile = existing ?? { profileId: `hprof-${randomUUID()}`, status: 'unprovisioned' as const };
  // switching to profile mode drops any header ciphertext.
  return { auth: { mode: 'profile', profile }, enc: undefined };
}

/**
 * True when the source is assigned to an active/activating production. Mutating
 * a source's auth material while it is on air is refused with 409 (spec §Error
 * codes; ADR-003 Decision 4 — the guard covers rotate/clear, not just PATCH).
 * Uses the same `findTrusted` `$elemMatch` selector as the delete guard (#257).
 */
async function isSourceInActiveProduction(sourceId: string): Promise<string | null> {
  const active = await getDb().findTrusted({
    selector: { type: 'production', status: { $in: ['active', 'activating'] }, 'sources': { $elemMatch: { sourceId } } },
    fields: ['_id', 'name'],
    limit: 1,
  });
  if (active.docs.length === 0) return null;
  return (active.docs[0] as unknown as Pick<ProductionDoc, 'name'>).name;
}

async function gatewayExists(gatewayId: string): Promise<boolean> {
  try {
    await getGatewaysDb().get(gatewayId);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
      return false;
    }
    throw err;
  }
}

function toApi(doc: SourceDoc) {
  // Strip internal-only fields: `_rev`/`type` (CouchDB bookkeeping) and
  // `authHeaderValueEnc` (the encrypted header credential — NEVER returned).
  const { _id, _rev, type, authHeaderValueEnc, auth, ...rest } = doc;
  const api: Record<string, unknown> = {
    id: _id,
    ...rest,
    // Passphrases are stored encrypted (encv1:...); decrypt before masking so the
    // mask matches on the "passphrase=" param regardless of storage form. Legacy
    // plaintext passphrases pass through decryption unchanged.
    address: maskSrtPassphrase(decryptAddressPassphrase(rest.address)),
  };
  if (auth !== undefined) {
    // Echo the masked auth: `header.valueSet` reflects whether a credential is
    // stored; the value itself is write-only and never included (issue #314).
    api['auth'] = maskAuth(auth, authHeaderValueEnc);
  }
  return api;
}

/**
 * Build the API-facing `auth` object from the stored form. The stored
 * `HtmlSourceAuth` never holds the plaintext credential — the ciphertext lives
 * on the separate `authHeaderValueEnc` field — so masking here just sets
 * `header.valueSet` from the presence of that ciphertext. Profile material is
 * echoed as-is (it holds no secret in v1). Never returns any secret material.
 */
function maskAuth(auth: HtmlSourceAuth, authHeaderValueEnc: string | undefined): HtmlSourceAuth {
  if (auth.mode === 'header') {
    return {
      mode: 'header',
      header: {
        name: auth.header?.name ?? '',
        valueSet: Boolean(authHeaderValueEnc),
      },
    };
  }
  // profile mode: echo the server-managed profile (no secret in v1).
  return { mode: 'profile', ...(auth.profile ? { profile: auth.profile } : {}) };
}

const sourcesRoutes: FastifyPluginAsync = async (fastify) => {
  // List all sources
  fastify.get('/api/v1/sources', async (_req, reply) => {
    const db = getSourcesDb();
    let result: Awaited<ReturnType<typeof db.find>>;
    try {
      result = await db.find({ selector: { type: 'source' } });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/sources — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable' });
    }
    return reply.send((Array.isArray(result?.docs) ? result.docs : []).map(toApi));
  });

  // Create a source
  fastify.post('/api/v1/sources', async (req, reply) => {
    const body = SourceInput.parse(req.body);
    // A provided gatewayId must name an existing gateway — reject a typo so the
    // source is never linked to a gateway that can never reach it (spec
    // studio-gateways.md, forget-cascade selector `{ type: 'source', gatewayId }`).
    if (body.gatewayId !== undefined && !(await gatewayExists(body.gatewayId))) {
      return reply.status(400).send({ error: `Gateway "${body.gatewayId}" not found`, statusCode: 400 });
    }
    const isSrt = body.streamType === 'srt' || body.streamType === 'efp';
    const id = `src-${randomUUID()}`;
    // A listener source binds a port on the shared Strom: it must lie inside this
    // instance's lease and no other source or output may hold it. Port 0 asks
    // for the lowest free one. Written, then checked again, because two clients
    // registering at once can both be handed the same free port.
    let used = isSrt ? await usedListenerPorts() : [];
    for (let attempt = 0; ; attempt++) {
      let address = body.address;
      let port: number | null = null;
      if (isSrt) {
        const resolved = resolveListenerAddress(body.address, getPortLease(), used);
        if (!resolved.ok) {
          return reply.status(resolved.statusCode).send({ error: resolved.error, statusCode: resolved.statusCode });
        }
        ({ address, port } = resolved);
      }
      const now = new Date().toISOString();
      // Translate any auth material into its stored form (header value encrypted
      // at rest, bound to the source id via GCM AAD; profile server-issued).
      const stored = body.auth !== undefined ? buildStoredAuth(body.auth, id, {}) : undefined;
      const doc: SourceDoc = {
        _id: id,
        type: 'source',
        name: body.name,
        // Encrypt any embedded SRT passphrase before it touches CouchDB (issue #160).
        address: encryptAddressPassphrase(address),
        streamType: body.streamType,
        status: body.status,
        liveCamera: body.liveCamera,
        latency: body.latency,
        // Only persist gatewayId when supplied — existing clients omit it and
        // the field stays absent, keeping the doc backward-compatible.
        ...(body.gatewayId !== undefined ? { gatewayId: body.gatewayId } : {}),
        ...(stored ? { auth: stored.auth } : {}),
        ...(stored?.enc ? { authHeaderValueEnc: stored.enc } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const written = await getSourcesDb().insert(doc);
      if (port === null) return reply.status(201).send(toApi(doc));
      used = await usedListenerPorts();
      const clash = clashesAfterWrite(used, { kind: 'source', id }, port);
      if (!clash) return reply.status(201).send(toApi(doc));
      await getSourcesDb().destroy(id, written.rev);
      if (listenerPortRequest(body.address) !== 0 || attempt >= 3) {
        return reply.status(409).send({ error: `SRT listener port ${port} is already used by ${clash.kind} "${clash.name}"`, statusCode: 409 });
      }
      fastify.log.warn({ port, clash }, 'listener port was taken while assigning it, choosing another');
    }
  });

  // Get a source
  fastify.get<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    try {
      const doc = await getSourcesDb().get(req.params.id);
      return reply.send(toApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
    }
  });

  // Update a source
  fastify.patch<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    const body = SourcePatch.parse(req.body);
    // A non-null gatewayId in the patch must name an existing gateway (same
    // guard as create). `null` clears the link and needs no lookup.
    if (typeof body.gatewayId === 'string' && !(await gatewayExists(body.gatewayId))) {
      return reply.status(400).send({ error: `Gateway "${body.gatewayId}" not found`, statusCode: 400 });
    }
    try {
      const doc = await getSourcesDb().get(req.params.id);
      // Determine effective streamType and address after the patch. Validate
      // against the plaintext form — a new body.address is already plaintext,
      // while the stored doc.address may hold an encrypted passphrase.
      const effectiveStreamType = body.streamType ?? doc.streamType;
      const effectiveAddress = body.address ?? decryptAddressPassphrase(doc.address);
      if (effectiveAddress) {
        try {
          if (effectiveStreamType === 'html') {
            graphicUrl(effectiveAddress);
          } else if (effectiveStreamType === 'srt' || effectiveStreamType === 'efp') {
            srtUrl(effectiveAddress);
          } else if (effectiveStreamType === 'clip') {
            // clip sources carry a serialized typed ClipReference (JSON) in address.
            deserializeClipReference(effectiveAddress);
          }
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid source address' });
        }
        // Re-check the port only when the address or stream type changes — a
        // rename must not fail because an older source predates the lease. Port 0
        // keeps the port the source already has when that is still valid.
        if (
          (body.address !== undefined || body.streamType !== undefined) &&
          (effectiveStreamType === 'srt' || effectiveStreamType === 'efp')
        ) {
          const stored = doc.streamType === 'srt' || doc.streamType === 'efp' ? listenerPortRequest(doc.address) : null;
          const resolved = resolveListenerAddress(effectiveAddress, getPortLease(), await usedListenerPorts(), {
            exclude: { kind: 'source', id: doc._id },
            keep: stored,
          });
          if (!resolved.ok) {
            return reply.status(resolved.statusCode).send({ error: resolved.error, statusCode: resolved.statusCode });
          }
          if (body.address !== undefined) body.address = resolved.address;
        }
      }
      // Auth material (issue #314): validated procedurally here because the
      // schema-level cross-check only fires when both address+streamType are in
      // the body. `auth` is only valid on an html source, and mode/shape must be
      // consistent (spec §Error codes → 400).
      if (body.auth !== undefined && body.auth !== null) {
        if (effectiveStreamType !== 'html') {
          return reply.status(400).send({ error: 'auth is only valid on an html source', statusCode: 400 });
        }
        if (body.auth.mode === 'header' && body.auth.header === undefined) {
          return reply.status(400).send({ error: 'header-mode auth requires a header', statusCode: 400 });
        }
        if (body.auth.mode === 'header' && body.auth.profile !== undefined) {
          return reply.status(400).send({ error: 'header-mode auth must not carry a profile', statusCode: 400 });
        }
        if (body.auth.mode === 'profile' && body.auth.header !== undefined) {
          return reply.status(400).send({ error: 'profile-mode auth must not carry a header', statusCode: 400 });
        }
      }
      // A source on air must not have its auth material mutated (spec §Error
      // codes → 409; ADR-003 Decision 4). Only guard when the patch actually
      // touches auth, so unrelated patches (rename) still work during a show.
      if (body.auth !== undefined) {
        const activeName = await isSourceInActiveProduction(doc._id);
        if (activeName !== null) {
          return reply.status(409).send({ error: `Source auth cannot be changed while in use by active production "${activeName}"`, statusCode: 409 });
        }
      }
      // Encrypt the passphrase in an updated address before persisting. When the
      // patch leaves the address untouched, keep the already-stored value as-is.
      const addressPatch = body.address !== undefined
        ? { address: encryptAddressPassphrase(body.address) }
        : {};
      // gatewayId is handled explicitly: a string re-links, `null` clears the
      // link (the field is removed so `findTrusted({ gatewayId })` no longer
      // matches), and an absent value leaves the stored link untouched. Strip
      // it from the spread so a raw `null` never lands in the persisted doc.
      // `auth` is likewise stripped: it needs stored-form translation (encrypt
      // header value onto `authHeaderValueEnc`) and must never land as-is.
      const { gatewayId: patchGatewayId, auth: patchAuth, ...bodyRest } = body;
      const updated: SourceDoc = { ...doc, ...bodyRest, ...addressPatch, updatedAt: new Date().toISOString() };
      if (patchGatewayId === null) {
        delete updated.gatewayId;
      } else if (typeof patchGatewayId === 'string') {
        updated.gatewayId = patchGatewayId;
      }
      if (patchAuth === null) {
        // Clear all auth material and any stored credential ciphertext.
        delete updated.auth;
        delete updated.authHeaderValueEnc;
      } else if (patchAuth !== undefined) {
        const stored = buildStoredAuth(patchAuth, doc._id, { auth: doc.auth, enc: doc.authHeaderValueEnc });
        updated.auth = stored.auth;
        if (stored.enc) {
          updated.authHeaderValueEnc = stored.enc;
        } else {
          delete updated.authHeaderValueEnc;
        }
      }
      await getSourcesDb().insert(updated);
      return reply.send(toApi(updated));
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
      }
      throw err;
    }
  });

  // Rotate (or clear) the stored Design-B header credential on an HTML source
  // (issue #314; mirrors POST /api/v1/gateways/:id/rotate-token, ADR-001). The
  // new value is write-only: accepted, encrypted at rest, never echoed. An empty
  // string (or `{ clear: true }`) clears the stored credential.
  const RotateBody = z.object({
    value: z.string().max(HEADER_VALUE_MAX).optional(),
    clear: z.boolean().optional(),
  }).strict();
  fastify.post<{ Params: { id: string } }>('/api/v1/sources/:id/auth/rotate', async (req, reply) => {
    const body = RotateBody.parse(req.body ?? {});
    let doc: SourceDoc;
    try {
      doc = await getSourcesDb().get(req.params.id);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
      }
      throw err;
    }
    // Rotating a credential is a mutation on the source's auth material and is
    // refused on an on-air source, same as PATCH (ADR-003 Decision 4 — the guard
    // covers rotate/clear, not just PATCH).
    const activeName = await isSourceInActiveProduction(doc._id);
    if (activeName !== null) {
      return reply.status(409).send({ error: `Source auth cannot be changed while in use by active production "${activeName}"`, statusCode: 409 });
    }
    // Rotate only applies to a header-mode auth (spec §Error codes: profile op on
    // a header-mode source, or vice-versa → 400).
    if (doc.auth?.mode !== 'header') {
      return reply.status(400).send({ error: 'Source has no header-mode auth to rotate', statusCode: 400 });
    }
    const updated: SourceDoc = { ...doc, updatedAt: new Date().toISOString() };
    if (body.clear === true || body.value === '' || body.value === undefined) {
      delete updated.authHeaderValueEnc;
    } else {
      updated.authHeaderValueEnc = encryptHtmlAuthValue(body.value, doc._id);
    }
    await getSourcesDb().insert(updated);
    return reply.send(toApi(updated));
  });

  // Design-C interactive-login provisioning — GATED. Stock upstream cefsrc has
  // no per-source isolated user-data dir (ADR-003 OQ2 → CONFIRMED-NO) and the
  // provisioning channel (OQ1) is undecided/unreviewed, so this returns 501 (the
  // same "accepted at the type level, not implemented" posture as clip `tams`,
  // spec §Error codes). The 501 is only lifted after a fresh security review.
  fastify.post<{ Params: { id: string } }>('/api/v1/sources/:id/auth/profile/provision', async (req, reply) => {
    try {
      await getSourcesDb().get(req.params.id);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
      }
      throw err;
    }
    return reply.status(501).send({
      error: 'Interactive-login profile provisioning is not implemented in v1 (upstream cefsrc gap; ADR-003 OQ1/OQ2)',
      statusCode: 501,
    });
  });

  // Report a Design-C profile's passive status so Studio can warn before
  // activation that a source login has expired (spec §API Design; ADR-003 OQ4).
  // Returns `unprovisioned` when the source has no profile-mode auth yet.
  fastify.get<{ Params: { id: string } }>('/api/v1/sources/:id/auth/profile/status', async (req, reply) => {
    let doc: SourceDoc;
    try {
      doc = await getSourcesDb().get(req.params.id);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
      }
      throw err;
    }
    if (doc.auth?.mode !== 'profile' || !doc.auth.profile) {
      return reply.send({ status: 'unprovisioned' as const });
    }
    const { profileId, status, lastProvisionedAt } = doc.auth.profile;
    return reply.send({ profileId, status, ...(lastProvisionedAt ? { lastProvisionedAt } : {}) });
  });

  // Delete a source
  fastify.delete<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    try {
      const doc = await getSourcesDb().get(req.params.id);

      // Block deletion if source is used by an active/activating production
      // findTrusted: operators are literals here; req.params.id is only ever a
      // scalar value inside $elemMatch, never a selector fragment (#257)
      const activeProductions = await getDb().findTrusted({
        selector: { type: 'production', status: { $in: ['active', 'activating'] }, 'sources': { $elemMatch: { sourceId: req.params.id } } },
        fields: ['_id', 'name'],
        limit: 1,
      });
      if (activeProductions.docs.length > 0) {
        const prod = activeProductions.docs[0] as unknown as Pick<ProductionDoc, '_id' | 'name'>;
        return reply.status(409).send({ error: `Source is in use by active production "${prod.name}"` });
      }

      // Remove references from inactive productions and record a warning
      // findTrusted: operators are literals here; req.params.id is only ever a
      // scalar value inside $elemMatch, never a selector fragment (#257)
      const inactiveProductions = await getDb().findTrusted({
        selector: { type: 'production', status: 'inactive', 'sources': { $elemMatch: { sourceId: req.params.id } } },
        fields: ['_id', 'name', 'sources', 'deletionWarnings'],
        limit: 100,
      });
      for (const p of inactiveProductions.docs) {
        const prod = p as unknown as ProductionDoc;
        const warnings = prod.deletionWarnings ?? [];
        warnings.push({ type: 'source', name: doc.name });
        await updateProductionDoc(prod._id, {
          sources: prod.sources.filter((s) => s.sourceId !== req.params.id),
          deletionWarnings: warnings,
        });
      }

      await getSourcesDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Source not found' });
      }
      throw err;
    }
  });
};

export default sourcesRoutes;
