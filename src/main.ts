import { config } from './config.js';
import { connectDb, getDb } from './db/index.js';
import { seedDefaultTemplate } from './db/seed.js';
import { buildServer } from './server.js';
import type { ProductionDoc } from './db/types.js';

/**
 * Startup recovery: reset any productions that were left in 'activating'
 * state (e.g. from a crash mid-polling loop) back to 'inactive'.
 */
async function recoverStaleActivations(): Promise<void> {
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
      console.info(`[startup] Reset stale 'activating' production ${doc._id} to 'inactive'`);
    } catch (err) {
      console.error(`[startup] Failed to reset production ${doc._id}:`, err);
    }
  }
}

async function main() {
  await connectDb();
  await seedDefaultTemplate();
  await recoverStaleActivations();

  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
