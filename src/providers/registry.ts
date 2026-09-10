/**
 * Polls each configured source provider and reconciles its candidates into
 * CouchDB as provider-owned SourceDocs (see SourceDoc.provider).
 *
 * Reconciliation per tick:
 *   - missing candidate → create
 *   - changed name/address/streamType/latency/status → update
 *   - unchanged → no write, so CouchDB is not touched every tick
 *   - provider-owned doc no longer listed → status 'inactive', doc kept
 *     (deleting would silently break production assignments)
 *   - provider or DB failure → docs left as they are until the next tick
 */

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { getSourcesDb, isDbConnected } from '../db/index.js';
import type { SourceDoc } from '../db/types.js';
import { httpUrlOnly, srtUrl } from '../lib/url-validation.js';
import { encryptAddressPassphrase, decryptAddressPassphrase } from '../lib/srt-passphrase-crypto.js';
import type { ProviderSource, SourceProvider } from './types.js';

/** Matches the cap SourceAssignmentInput.sourceId enforces in routes/productions.ts. */
const MAX_SOURCE_ID_LENGTH = 128;

export interface SkippedCandidate {
  externalId: string;
  reason: string;
}

export interface SyncResult {
  created: number;
  updated: number;
  deactivated: number;
  skipped: SkippedCandidate[];
}

export function providerSourceId(providerId: string, externalId: string): string {
  const slug = externalId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `src-ext-${providerId}-${slug}`.slice(0, MAX_SOURCE_ID_LENGTH);
}

/**
 * The `never` default makes an added ProviderSource.streamType a compile error
 * here, so a new stream type cannot reach the DB unvalidated.
 */
function assertCandidateAddress(candidate: ProviderSource): void {
  const allowPrivateHosts = config.sourceProviderAllowPrivateHosts;
  switch (candidate.streamType) {
    case 'srt':
    case 'efp':
      return srtUrl(candidate.address, { allowPrivateHosts });
    case 'whip':
      return httpUrlOnly(candidate.address, { allowPrivateHosts });
    default: {
      const unsupported: never = candidate.streamType;
      throw new Error(`unsupported stream type "${String(unsupported)}"`);
    }
  }
}

function validateCandidate(candidate: ProviderSource): string | null {
  if (!candidate.externalId) return 'missing externalId';
  if (!candidate.name) return 'missing name';
  try {
    assertCandidateAddress(candidate);
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid address';
  }
  return null;
}

function isUpToDate(doc: SourceDoc, candidate: ProviderSource): boolean {
  return doc.name === candidate.name
    && doc.streamType === candidate.streamType
    && decryptAddressPassphrase(doc.address) === candidate.address
    && doc.latency === candidate.latency
    && doc.status === (candidate.status ?? 'active');
}

function applyCandidate(
  provider: SourceProvider,
  candidate: ProviderSource,
  current: SourceDoc | undefined,
  now: string,
): SourceDoc {
  const base: Pick<SourceDoc, '_id' | '_rev' | 'type' | 'createdAt' | 'liveCamera'> = current ?? {
    _id: providerSourceId(provider.id, candidate.externalId),
    type: 'source',
    createdAt: now,
  };
  return {
    ...base,
    name: candidate.name,
    address: encryptAddressPassphrase(candidate.address),
    streamType: candidate.streamType,
    status: candidate.status ?? 'active',
    latency: candidate.latency,
    provider: { id: provider.id, externalId: candidate.externalId, syncedAt: now },
    updatedAt: now,
  };
}

function isConflict(err: unknown): boolean {
  return err instanceof Error && 'statusCode' in err && (err as { statusCode?: number }).statusCode === 409;
}

/** Insert `apply(current)`; on a 409 _rev conflict re-read the doc and apply once more. */
async function upsert(
  id: string,
  current: SourceDoc | undefined,
  apply: (current: SourceDoc | undefined) => SourceDoc,
): Promise<void> {
  const db = getSourcesDb();
  try {
    await db.insert(apply(current));
  } catch (err) {
    if (!isConflict(err)) throw err;
    const latest = await db.get(id);
    await db.insert(apply(latest));
  }
}

/** One reconciliation pass for a single provider. Throws if the provider or CouchDB fails. */
export async function syncProvider(provider: SourceProvider, log: FastifyBaseLogger): Promise<SyncResult> {
  const candidates = await provider.list();
  const result: SyncResult = { created: 0, updated: 0, deactivated: 0, skipped: [] };

  const existing = await getSourcesDb().find({ selector: { type: 'source', 'provider.id': provider.id } });
  const byExternalId = new Map<string, SourceDoc>();
  for (const doc of existing.docs) {
    if (doc.provider) byExternalId.set(doc.provider.externalId, doc);
  }

  const now = new Date().toISOString();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const reason = validateCandidate(candidate) ?? (seen.has(candidate.externalId) ? 'duplicate externalId' : null);
    if (reason) {
      result.skipped.push({ externalId: candidate.externalId, reason });
      continue;
    }
    seen.add(candidate.externalId);

    const current = byExternalId.get(candidate.externalId);
    if (current && isUpToDate(current, candidate)) continue;

    const id = current?._id ?? providerSourceId(provider.id, candidate.externalId);
    await upsert(id, current, (doc) => applyCandidate(provider, candidate, doc, now));
    if (current) result.updated++; else result.created++;
    log.debug({ provider: provider.id, sourceId: id, externalId: candidate.externalId }, current ? '[providers] Updated source' : '[providers] Created source');
  }

  for (const [externalId, doc] of byExternalId) {
    if (seen.has(externalId) || doc.status === 'inactive') continue;
    await upsert(doc._id, doc, (latest) => ({
      ...(latest ?? doc),
      status: 'inactive',
      provider: { id: provider.id, externalId, syncedAt: now },
      updatedAt: now,
    }));
    result.deactivated++;
    log.debug({ provider: provider.id, sourceId: doc._id, externalId }, '[providers] Source no longer listed — marked inactive');
  }

  return result;
}

/**
 * Poll the providers forever, one pass at a time. Failures are logged once per
 * state change so a provider outage does not flood the log at the poll rate.
 * Returns a stop function.
 */
export function startSourceProviderSync(
  providers: SourceProvider[],
  log: FastifyBaseLogger,
  pollMs: number,
): () => void {
  const failing = new Set<string>();
  const lastSkipped = new Map<string, string>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    if (isDbConnected()) {
      for (const provider of providers) {
        try {
          const result = await syncProvider(provider, log);
          if (failing.delete(provider.id)) {
            log.info({ provider: provider.id }, '[providers] Sync recovered');
          }
          if (result.created || result.updated || result.deactivated) {
            const { skipped: _skipped, ...counts } = result;
            log.info({ provider: provider.id, ...counts }, '[providers] Synced sources');
          }
          const skippedKey = JSON.stringify(result.skipped);
          if (skippedKey !== lastSkipped.get(provider.id)) {
            lastSkipped.set(provider.id, skippedKey);
            if (result.skipped.length > 0) {
              log.warn({ provider: provider.id, skipped: result.skipped }, '[providers] Skipped invalid source candidates');
            }
          }
        } catch (err) {
          if (!failing.has(provider.id)) {
            failing.add(provider.id);
            log.error({ err, provider: provider.id }, '[providers] Sync failed — keeping existing sources until the provider recovers');
          }
        }
      }
    } else {
      log.debug('[providers] Database not connected — skipping sync');
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };

  log.info({ providers: providers.map((p) => p.id), pollMs }, '[providers] Source provider sync started');
  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
