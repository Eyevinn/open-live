import { config } from './config.js';
import { connectDb, getDb } from './db/index.js';
import { seedDefaultTemplate } from './db/seed.js';
import { buildServer } from './server.js';
import type { ProductionDoc } from './db/types.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Startup recovery: reset any productions that were left in 'activating'
 * state (e.g. from a crash mid-polling loop) back to 'inactive'.
 */
async function recoverStaleActivations(
  log: FastifyBaseLogger,
): Promise<void> {
  const db = getDb();
  const result = await db.find({ selector: { type: 'production', status: 'activating' } });
  for (const doc of result.docs as ProductionDoc[]) {
    try {
      const updated: ProductionDoc = {
        ...doc,
        status: 'inactive',
        stromFlowId: undefined,
        mixerBlockId: undefined,
        whepEndpoint: undefined,
        updatedAt: new Date().toISOString(),
      };
      await db.insert(updated);
      log.info({ productionId: doc._id }, "[startup] Reset stale 'activating' production to 'inactive'");
    } catch (err) {
      log.error({ err, productionId: doc._id }, '[startup] Failed to reset production to inactive');
    }
  }
}

async function main() {
  await connectDb();
  await seedDefaultTemplate();

  const app = await buildServer();
  await recoverStaleActivations(app.log);
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
