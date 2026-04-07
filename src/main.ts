import { config } from './config.js';
import { connectDb } from './db/index.js';
import { seedDefaultTemplate } from './db/seed.js';
import { buildServer } from './server.js';

async function main() {
  await connectDb();
  await seedDefaultTemplate();

  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
