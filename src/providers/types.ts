/**
 * A source provider lists source candidates produced by another system.
 * The registry materialises them as ordinary, read-only SourceDocs so the rest
 * of open-live (assignment, activation, the studio UI) needs no knowledge of
 * where they came from. Providers are polled; there is no push API.
 */

export interface ProviderSource {
  /** Stable within the provider. Slugged into the source id, so keep it short. */
  externalId: string;
  name: string;
  streamType: 'srt' | 'efp' | 'whip';
  /** Validated before it is stored: srtUrl() for srt/efp, httpUrlOnly() for whip. */
  address: string;
  latency?: number;
  /** Defaults to 'active'. */
  status?: 'active' | 'inactive';
}

export interface SourceProvider {
  /** Short slug such as 'weave'; becomes part of every source id the provider owns. */
  readonly id: string;
  list(): Promise<ProviderSource[]>;
}
