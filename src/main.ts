import { config } from './config.js';
import { startIdleWatchdog } from './services/idle-watchdog.js';
import { startGpuUsageSweep, stopGpuUsageSweep } from './services/gpu-usage.js';
import { startPortReservation, stopPortReservation } from './services/port-reservation.js';
import { connectDbAndInit, startDbConnectRetry, stopDbConnectRetry } from './lib/post-connect-init.js';
import { buildServer } from './server.js';

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

  const app = await buildServer();

  // Post-connect init (key bootstraps, migrations, reconcile, upload resume)
  // lives in one idempotent helper shared with /api/v1/reconnect (issue #581).
  // If CouchDB is unreachable at startup, keep serving and retry in the
  // background so the instance recovers without a restart.
  try {
    await connectDbAndInit(app.log);
  } catch (err: any) {
    app.log.error('[db] Failed to connect to CouchDB — continuing without database, retrying in background (status: %s)', err?.statusCode ?? err?.message ?? 'unknown');
    startDbConnectRetry(app.log);
  }

  startIdleWatchdog(app.log);
  // Shared-GPU usage settle sweep (issue #500). No-op unless metering is enabled
  // (`isGpuMeteringEnabled()`: explicit GPU_POOL, or the platform default for a
  // managed shared-Strom instance, issues #537/#547, always on), so self-hosted / BYO-Strom
  // deployments are unchanged. Reconcile has already run
  // above, so a production found still live after a restart has kept its
  // activatedAt and the first sweep accrues the hours elapsed across the downtime
  // from the recorded start, not from zero.
  // It also sets the accrual floor (issue #535) from the persisted metering
  // `enabledAt` marker before the server listens, so nothing from before
  // metering was enabled on this instance is ever reported.
  await startGpuUsageSweep(app.log);
  startPortReservation(app.log);
  await app.listen({ port: config.port, host: '0.0.0.0' });

  // Graceful shutdown: release the Strom port lease so the range is free for
  // the next instance, then close the server. Force-exit if it stalls.
  const onSignal = (signal: NodeJS.Signals): void => {
    app.log.info({ signal }, 'Shutting down');
    setTimeout(() => process.exit(1), 5000).unref();
    void (async () => {
      stopGpuUsageSweep();
      stopDbConnectRetry();
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
