/**
 * Post-connect initialisation (issue #581, OL-33).
 *
 * Everything that must run once CouchDB is reachable: the key bootstraps
 * (guest signing key #391, credential encryption key #438, RTMP stream-key key
 * #447), legacy-fixture cleanup, the one-time migrations, status reconcile and
 * the live-recording upload resume.
 *
 * This used to live only in `main.ts`'s startup DB-success branch, so an
 * instance whose first CouchDB connect failed (e.g. a 401 while the managed
 * instance's credentials were still being provisioned) never ran it: a later
 * successful `POST /api/v1/reconnect` restored the DB handle but left the key
 * caches empty, and credential writes (storage connections, SRT passphrases,
 * RTMP stream keys, guest invites) failed closed with a 503 until a restart.
 *
 * `connectDbAndInit()` is the single entry point used at startup, by
 * `/api/v1/reconnect` and by the background retry. It is:
 * - idempotent: the key bootstraps are cached (and re-attempted on a later call
 *   if one failed); the once-only steps run only until they have completed;
 * - concurrency-safe: overlapping calls share one in-flight promise.
 *
 * Fail-closed behaviour and env-override precedence are untouched — they live in
 * the `ensure*` key modules and the crypto modules, which this only calls.
 */

import type { FastifyBaseLogger } from 'fastify';
import { connectDb, isDbConnected } from '../db/index.js';
import { cleanLegacyFixtures } from '../db/seed.js';
import { ensureGuestSigningKey } from './guest-signing-key.js';
import { ensureCredentialEncryptionKey } from './credential-encryption-key.js';
import { ensureRtmpCredentialKey } from './rtmp-credential-key.js';
import { migrateAudioChannelOrder } from '../services/migrate-audio-channel-order.js';
import { migrateRecordingKind } from '../services/migrate-recording-kind.js';
import { reconcileProductionStatuses } from '../services/reconcile.js';
import { resumeLiveRecordingUploads } from '../services/live-recording-upload.js';

let inFlight: Promise<void> | null = null;
/** True once the once-only steps (fixtures, migrations, reconcile, resume) have run. */
let onceStepsDone = false;

let retryTimer: NodeJS.Timeout | null = null;
let retryStopped = false;

const RETRY_INITIAL_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

function reason(err: any): string {
  return err?.statusCode ?? err?.message ?? 'unknown';
}

async function bootstrapKeys(log: FastifyBaseLogger): Promise<void> {
  // Guest calling is on by default (issue #391): ensure a signing key exists —
  // generated and stored on first start, reused on every restart. The key is
  // never logged. Env `GUEST_INVITE_SECRET`, if set, overrides it. Best-effort:
  // guest routes degrade to 503 until a key is available.
  try {
    await ensureGuestSigningKey();
    log.info('[guest-calling] Invite signing key ready');
  } catch (err: any) {
    log.error(
      '[guest-calling] Failed to load/generate invite signing key — guest routes will 503 until it is available (reason: %s)',
      reason(err),
    );
  }
  // Credential encryption key (issue #438): generated and stored on first start,
  // reused on every restart, so SRT passphrases / HTML-source credentials /
  // storage-connection secrets can be stored at rest on OSC without a key env
  // var. `SRT_PASSPHRASE_KEY` / `HTML_AUTH_KEY` still override it. Never logged.
  // Best-effort: credential writes degrade to 503 until a key is available.
  try {
    await ensureCredentialEncryptionKey();
    log.info('[credential-storage] Encryption key ready');
  } catch (err: any) {
    log.error(
      '[credential-storage] Failed to load/generate credential encryption key — credential writes will 503 until it is available (reason: %s)',
      reason(err),
    );
  }
  // RTMP stream-key encryption key (issue #447): a DEDICATED key under its own
  // doc id — RTMP never reuses the SRT/credential key (ADR-004 Resolved
  // Decision 2). `RTMP_CREDENTIALS_KEY` still overrides it. Never logged.
  // Best-effort: RTMP stream-key writes degrade to 503 until a key is available.
  try {
    await ensureRtmpCredentialKey();
    log.info('[credential-storage] RTMP stream-key encryption key ready');
  } catch (err: any) {
    log.error(
      '[credential-storage] Failed to load/generate RTMP stream-key encryption key — RTMP stream-key writes will 503 until it is available (reason: %s)',
      reason(err),
    );
  }
}

async function runOnceSteps(log: FastifyBaseLogger): Promise<void> {
  await cleanLegacyFixtures();
  // One-time migration (issue #487): the audio channel sort changed to numeric
  // pad order, which renumbers channels for productions with a guest or 10+
  // sources. Remap persisted per-channel `ch{N}_aux{M}_pre` settings BEFORE any
  // flow is (re)built so operator pre/post choices follow their source. Runs at
  // most once per instance; best-effort — a failure retries on next start.
  try {
    await migrateAudioChannelOrder(log);
  } catch (err: any) {
    log.error('[migrate:audio-channel-order] Migration errored — will retry next start (reason: %s)', reason(err));
  }
  // One-time migration (OL-32a): backfill `kind: 'program'` on recordings
  // written before the field existed. Best-effort; an interrupted run resumes
  // on the next start.
  try {
    await migrateRecordingKind(log);
  } catch (err: any) {
    log.error('[migrate:recording-kind] Migration errored — will retry next start (reason: %s)', reason(err));
  }
  await reconcileProductionStatuses(log);
  // Productions still live after a restart: upload the recording parts that
  // closed while open-live was down, and keep uploading (issue #556).
  await resumeLiveRecordingUploads(log);
}

/**
 * Connect to CouchDB if not yet connected, then run the post-connect init.
 * Rejects if the connect (or a non-best-effort init step) fails. Overlapping
 * calls share one in-flight run.
 */
export function connectDbAndInit(log: FastifyBaseLogger): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!isDbConnected()) {
      await connectDb();
      log.info('[db] Connected to CouchDB');
    }
    await bootstrapKeys(log);
    if (!onceStepsDone) {
      await runOnceSteps(log);
      onceStepsDone = true;
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Retry `connectDbAndInit()` in the background with exponential backoff
 * (5 s doubling, capped at 5 min) until it succeeds. Used when the startup
 * connect fails, so the instance recovers without a restart or a manual
 * `/api/v1/reconnect`. Timers are unref'd so they never hold the process open.
 */
export function startDbConnectRetry(log: FastifyBaseLogger): void {
  if (retryTimer) return;
  retryStopped = false;
  let delay = RETRY_INITIAL_MS;
  const schedule = (): void => {
    if (retryStopped) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connectDbAndInit(log).then(
        () => {
          log.info('[db] Background reconnect succeeded — post-connect init complete');
        },
        (err: any) => {
          delay = Math.min(delay * 2, RETRY_MAX_MS);
          log.warn('[db] Background reconnect failed — retrying in %ds (reason: %s)', Math.round(delay / 1000), reason(err));
          schedule();
        },
      );
    }, delay);
    retryTimer.unref();
  };
  schedule();
}

/** Stop the background retry (graceful shutdown). */
export function stopDbConnectRetry(): void {
  retryStopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** Test-only: reset module state between cases. */
export function __resetPostConnectInitForTests(): void {
  stopDbConnectRetry();
  inFlight = null;
  onceStepsDone = false;
}
