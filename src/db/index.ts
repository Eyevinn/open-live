import Nano from 'nano';
import { config } from '../config.js';
import type { ProductionDoc } from './types.js';

let db: Nano.DocumentScope<ProductionDoc>;

export function getDb(): Nano.DocumentScope<ProductionDoc> {
  return db;
}

export async function connectDb(): Promise<void> {
  const nano = Nano(config.couchdbUrl);
  const dbList = await nano.db.list();
  if (!dbList.includes(config.couchdbName)) {
    await nano.db.create(config.couchdbName);
  }
  db = nano.use<ProductionDoc>(config.couchdbName);
}

export async function isDbReady(): Promise<boolean> {
  try {
    const nano = Nano(config.couchdbUrl);
    await nano.db.list();
    return true;
  } catch {
    return false;
  }
}
