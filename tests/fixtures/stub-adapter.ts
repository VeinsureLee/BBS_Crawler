import type { SiteAdapter, Thread, ThreadSummary } from '../../src/core/site-adapter';

export interface StubAdapterOptions {
  siteKey?: string;
  thread?: Thread;
  list?: ThreadSummary[];
  search?: ThreadSummary[];
  initiallyLoggedIn?: boolean;
}

export function createStubAdapter(opts: StubAdapterOptions = {}): SiteAdapter {
  let loggedIn = opts.initiallyLoggedIn ?? true;
  const siteKey = opts.siteKey ?? 'stub';
  return {
    siteKey,
    displayName: `Stub ${siteKey}`,
    baseUrl: `https://${siteKey}.example.invalid`,
    requiresAuth: false,
    async isLoggedIn() { return loggedIn; },
    async login() { loggedIn = true; },
    async listThreads() { return opts.list ?? []; },
    async getThread() {
      if (!opts.thread) throw new Error('stub adapter has no thread configured');
      return opts.thread;
    },
    async search() { return opts.search ?? []; },
  };
}
