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
  stromUrl: process.env['STROM_URL'] ?? 'http://localhost:7000',
  stromToken: process.env['STROM_TOKEN'] ?? undefined,
  /** 'osc' = PAT→SAT exchange via token.svc.prod.osaas.io (default for OSC-hosted Strom)
   *  'direct' = API key used as Bearer token directly (self-hosted / non-OSC Strom) */
  stromAuthMode: (process.env['STROM_AUTH_MODE'] ?? 'osc') as 'osc' | 'direct',
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
} as const;
