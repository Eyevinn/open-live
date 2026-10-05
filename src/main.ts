import { config, objectStorageMissingVars } from './config.js';
import { startIdleWatchdog } from './services/idle-watchdog.js';
import { startPortReservation, stopPortReservation } from './services/port-reservation.js';
import { connectDb } from './db/index.js';
import { cleanLegacyFixtures } from './db/seed.js';
import { ensureGuestSigningKey } from './lib/guest-signing-key.js';
import { ensureCredentialEncryptionKey } from './lib/credential-encryption-key.js';
import { ensureRtmpCredentialKey } from './lib/rtmp-credential-key.js';
import { buildServer } from './server.js';
import { reconcileProductionStatuses } from './services/reconcile.js';

async function main() {
  // API_KEY is required in production. Without it every route is unauthenticated,
  // allowing any client that can reach port 3000 to create, modify, and delete
  // productions. Omitting API_KEY is intentional only when TRUST_EXTERNAL_AUTH
  // acknowledges that another layer (e.g. OSC's reverse proxy) handles auth
  // instead. NODE_ENV is deliberately NOT used as that signal: it reflects the
  // deployment tier, not the auth architecture, and OSC-hosted deployments
  // always run with NODE_ENV=production regardless of whether they sit behind
  // that reverse proxy — so NODE_ENV alone can't distinguish "no auth wall" from
  // "auth handled externally".
  if (!config.apiKey) {
    if (process.env['NODE_ENV'] === 'production' && !config.trustExternalAuth) {
      throw new Error(
        'API_KEY must be set in production deployments. ' +
        'Without it all API routes are unauthenticated. ' +
        'Set API_KEY to a strong random secret, or set TRUST_EXTERNAL_AUTH=true ' +
        'if this deployment intentionally relies on an external auth layer ' +
        '(e.g. the OSC reverse proxy).'
      );
    } else {
      console.warn(
        '[security] API_KEY is not set — all /api/v1 routes are unauthenticated. ' +
        'Set API_KEY before deploying to production.'
      );
    }
  }

  // PUBLIC_BASE_URL is required in production to prevent X-Forwarded-Host injection.
  // Without it, the activation endpoint derives the public WHIP URL from the raw
  // X-Forwarded-Host header, which an attacker can forge to redirect camera streams
  // to an attacker-controlled server (CVE category: host-header injection).
  if (!config.publicBaseUrl) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'PUBLIC_BASE_URL must be set in production deployments. ' +
        'Without it the activation endpoint derives WHIP endpoint URLs from the ' +
        'X-Forwarded-Host request header, enabling host-header injection attacks.'
      );
    } else {
      console.warn(
        '[security] PUBLIC_BASE_URL is not set. WHIP endpoint URLs will be derived ' +
        'from request headers (X-Forwarded-Host / Host). Set PUBLIC_BASE_URL to the ' +
        'externally reachable URL of this service before deploying to production.'
      );
    }
  }

  // Credential storage (issue #349): the crypto modules fail closed in
  // production (ADR-003 Decision 4) — with no encryption key set, any request
  // that would store an HTML-source header credential or an SRT passphrase is
  // refused with a 503 config error rather than stored in plaintext. Warn once
  // at startup so operators learn about the misconfiguration before a user hits
  // it, instead of only discovering it from a failed save. HTML_AUTH_KEY falls
  // back to SRT_PASSPHRASE_KEY, so either one satisfies both crypto paths.
  if (
    process.env['NODE_ENV'] === 'production' &&
    !process.env['HTML_AUTH_KEY'] &&
    !process.env['SRT_PASSPHRASE_KEY']
  ) {
    console.warn(
      '[credential-storage] Neither HTML_AUTH_KEY nor SRT_PASSPHRASE_KEY is set. ' +
      'Storing HTML-source header credentials or SRT passphrases will fail closed ' +
      'with a 503 (credentials are never stored in plaintext). Set HTML_AUTH_KEY ' +
      '(or SRT_PASSPHRASE_KEY) to a 32-byte base64/hex key to enable credential storage.'
    );
  }

  // A partial MinIO config is treated as no object storage: recordings stay on
  // Strom and are never uploaded. Warn so a typo'd or forgotten var is visible.
  const missingStorageVars = objectStorageMissingVars();
  if (missingStorageVars.length > 0) {
    console.warn(
      `[recording] Object storage is partially configured (missing ${missingStorageVars.join(', ')}). ` +
      'Recordings will stay on Strom and will not be uploaded. Set all of MINIO_ENDPOINT, ' +
      'MINIO_ACCESS_KEY, MINIO_SECRET_KEY and MINIO_BUCKET to upload, or unset them all.'
    );
  }

  const app = await buildServer();

  try {
    await connectDb();
    app.log.info('[db] Connected to CouchDB');
    // Guest calling is on by default (issue #391): ensure a signing key exists —
    // generated and stored on first start, reused on every restart. The key is
    // never logged. Env `GUEST_INVITE_SECRET`, if set, overrides it. Best-effort:
    // a failure here must not block startup (guest routes degrade to 503 until a
    // key is available), mirroring the DB-failure handling below.
    try {
      await ensureGuestSigningKey();
      app.log.info('[guest-calling] Invite signing key ready');
    } catch (err: any) {
      app.log.error(
        '[guest-calling] Failed to load/generate invite signing key — guest routes will 503 until it is available (reason: %s)',
        err?.statusCode ?? err?.message ?? 'unknown',
      );
    }
    // Credential encryption key (issue #438): generated and stored on first start,
    // reused on every restart, so SRT passphrases / HTML-source credentials can be
    // stored at rest on OSC without a key env var. `SRT_PASSPHRASE_KEY` /
    // `HTML_AUTH_KEY` still override it. The key is never logged. Best-effort: a
    // failure here must not block startup (credential writes degrade to 503 until
    // a key is available), mirroring the signing-key handling above.
    try {
      await ensureCredentialEncryptionKey();
      app.log.info('[credential-storage] Encryption key ready');
    } catch (err: any) {
      app.log.error(
        '[credential-storage] Failed to load/generate credential encryption key — credential writes will 503 until it is available (reason: %s)',
        err?.statusCode ?? err?.message ?? 'unknown',
      );
    }
    // RTMP stream-key encryption key (issue #447): a DEDICATED key, generated and
    // stored on first start under its own doc id, reused on every restart, so RTMP
    // stream keys can be stored at rest on OSC without a key env var. Kept separate
    // from the credential key above — RTMP never reuses the SRT/credential key
    // (ADR-004 Resolved Decision 2). `RTMP_CREDENTIALS_KEY` still overrides it. The
    // key is never logged. Best-effort: a failure here must not block startup (RTMP
    // stream-key writes degrade to 503 until a key is available).
    try {
      await ensureRtmpCredentialKey();
      app.log.info('[credential-storage] RTMP stream-key encryption key ready');
    } catch (err: any) {
      app.log.error(
        '[credential-storage] Failed to load/generate RTMP stream-key encryption key — RTMP stream-key writes will 503 until it is available (reason: %s)',
        err?.statusCode ?? err?.message ?? 'unknown',
      );
    }
    await cleanLegacyFixtures();
    await reconcileProductionStatuses(app.log);
  } catch (err: any) {
    app.log.error('[db] Failed to connect to CouchDB — continuing without database (status: %s)', err?.statusCode ?? err?.message ?? 'unknown');
  }

  startIdleWatchdog(app.log);
  startPortReservation(app.log);
  await app.listen({ port: config.port, host: '0.0.0.0' });

  // Graceful shutdown: release the Strom port lease so the range is free for
  // the next instance, then close the server. Force-exit if it stalls.
  const onSignal = (signal: NodeJS.Signals): void => {
    app.log.info({ signal }, 'Shutting down');
    setTimeout(() => process.exit(1), 5000).unref();
    void (async () => {
      await stopPortReservation(app.log);
      await app.close();
      process.exit(0);
    })();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

const shutdown = (err: unknown, origin: string): void => {
  console.error({ err, origin }, 'Fatal error — shutting down');
  // Force-exit if graceful shutdown stalls
  setTimeout(() => process.exit(1), 5000).unref();
  process.exit(1);
};

process.on('uncaughtException', (err, origin) => shutdown(err, origin));
process.on('unhandledRejection', (reason) => shutdown(reason, 'unhandledRejection'));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
