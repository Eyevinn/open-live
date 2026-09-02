import type { SourceProvider } from './types.js';

const PROVIDER_FACTORIES: Record<string, () => SourceProvider> = {};

/** Resolve SOURCE_PROVIDERS ids to provider instances. Throws on an unknown id so a typo fails startup. */
export function createSourceProviders(ids: string[]): SourceProvider[] {
  return ids.map((id) => {
    const factory = PROVIDER_FACTORIES[id];
    if (!factory) {
      const known = Object.keys(PROVIDER_FACTORIES).join(', ') || 'none';
      throw new Error(`Unknown source provider '${id}' in SOURCE_PROVIDERS (known: ${known})`);
    }
    return factory();
  });
}
