function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  couchdbUrl: requireEnv('COUCHDB_URL'),
  couchdbName: process.env['COUCHDB_NAME'] ?? 'open-live',
  corsOrigin: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
} as const;
