import { UnknownSiteError } from './errors.js';
import type { SiteAdapter } from '../contract/site-adapter.js';

const adapters = new Map<string, SiteAdapter>();

export function register(adapter: SiteAdapter): void {
  adapters.set(adapter.siteKey, adapter);
}

export function getAdapter(siteKey: string): SiteAdapter {
  const a = adapters.get(siteKey);
  if (!a) throw new UnknownSiteError(siteKey, [...adapters.keys()]);
  return a;
}

export function listAdapters(): SiteAdapter[] {
  return [...adapters.values()];
}

/** Test-only helper. */
export function _resetForTests(): void {
  adapters.clear();
}
