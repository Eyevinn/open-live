import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getSourcesDb, getDb } from '../db/index.js';
import type { SourceDoc, ProductionDoc } from '../db/types.js';
import { updateProductionDoc } from './productions.js';
import { graphicUrl, srtUrl } from '../lib/url-validation.js';
import { encryptAddressPassphrase, decryptAddressPassphrase } from '../lib/srt-passphrase-crypto.js';
import { getPortLease } from '../services/port-lease.js';
import { clashesAfterWrite, listenerPortRequest, resolveListenerAddress, usedListenerPorts } from '../services/listener-ports.js';

const SourceInput = z.object({
  name: z.string().min(1).max(256),
  address: z.string(),
  streamType: z.enum(['srt', 'efp', 'whip', 'html']),
  status: z.enum(['active', 'inactive']).default('inactive'),
  liveCamera: z.boolean().optional(),
  latency: z.number().int().min(20).max(8000).optional(),
}).superRefine((data, ctx) => {
  if (data.streamType === 'html') {
    // html sources use a browser URL — validate for SSRF (file://, javascript:, private IPs, etc.)
    try {
      graphicUrl(data.address);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: err instanceof Error ? err.message : 'Invalid HTML source URL' });
    }
  } else if (data.streamType === 'srt' || data.streamType === 'efp') {
    // SRT/EFP sources: must be a valid srt:// URI pointing to a non-private host
    try {
      srtUrl(data.address);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: err instanceof Error ? err.message : 'Invalid SRT source address' });
    }
  }
});

const SourcePatch = z.object({
  name: z.string().min(1).max(256).optional(),
  address: z.string().optional(),
  streamType: z.enum(['srt', 'efp', 'whip', 'html']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  liveCamera: z.boolean().optional(),
  latency: z.number().int().min(20).max(8000).optional(),
}).superRefine((data, ctx) => {
  // Cross-field validation only applies when both address and streamType are present in
  // the same patch body. The combined-with-existing-document case is validated procedurally
  // in the route handler, which has access to the stored source document.
  if (data.address === undefined || data.streamType === undefined) {
    return;
  }
  if (data.streamType === 'html') {
    // html sources use a browser URL — validate for SSRF (file://, javascript:, private IPs, etc.)
    try {
      graphicUrl(data.address);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: err instanceof Error ? err.message : 'Invalid HTML source URL' });
    }
  } else if (data.streamType === 'srt' || data.streamType === 'efp') {
    // SRT/EFP sources: must be a valid srt:// URI pointing to a non-private host
    try {
      srtUrl(data.address);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: err instanceof Error ? err.message : 'Invalid SRT source address' });
    }
  }
});

/** Masks passphrase values in SRT URIs so credentials are never returned to clients. */
function maskSrtPassphrase(address: string): string {
  return address.replace(/([?&]passphrase=)[^&]*/gi, '$1***');
}

function toApi(doc: SourceDoc) {
  const { _id, _rev, type, ...rest } = doc;
  // Passphrases are stored encrypted (encv1:...); decrypt before masking so the
  // mask matches on the "passphrase=" param regardless of storage form. Legacy
  // plaintext passphrases pass through decryption unchanged.
  return { id: _id, ...rest, address: maskSrtPassphrase(decryptAddressPassphrase(rest.address)) };
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
      // Encrypt the passphrase in an updated address before persisting. When the
      // patch leaves the address untouched, keep the already-stored value as-is.
      const addressPatch = body.address !== undefined
        ? { address: encryptAddressPassphrase(body.address) }
        : {};
      const updated: SourceDoc = { ...doc, ...body, ...addressPatch, updatedAt: new Date().toISOString() };
      await getSourcesDb().insert(updated);
      return reply.send(toApi(updated));
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
      }
      throw err;
    }
  });

  // Delete a source
  fastify.delete<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    try {
      const doc = await getSourcesDb().get(req.params.id);

      // Block deletion if source is used by an active/activating production
      const activeProductions = await getDb().find({
        selector: { type: 'production', status: { $in: ['active', 'activating'] }, 'sources': { $elemMatch: { sourceId: req.params.id } } },
        fields: ['_id', 'name'],
        limit: 1,
      });
      if (activeProductions.docs.length > 0) {
        const prod = activeProductions.docs[0] as unknown as Pick<ProductionDoc, '_id' | 'name'>;
        return reply.status(409).send({ error: `Source is in use by active production "${prod.name}"` });
      }

      // Remove references from inactive productions and record a warning
      const inactiveProductions = await getDb().find({
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
