import { describe, it, expect, beforeEach } from 'vitest';
import { register, getAdapter, listAdapters, _resetForTests } from '../../../src/core/registry';
import { UnknownSiteError } from '../../../src/core/errors';
import type { SiteAdapter } from '../../../src/contract/site-adapter';

const fakeAdapter = (siteKey: string): SiteAdapter => ({
  siteKey,
  displayName: siteKey,
  baseUrl: 'https://example.invalid',
  requiresAuth: true,
  async isLoggedIn() { return false; },
  async login() { /* no-op */ },
  async listThreads() { return []; },
  async getThread() { throw new Error('unused'); },
  async search() { return []; },
});

beforeEach(() => _resetForTests());

describe('registry', () => {
  it('registers and retrieves an adapter by siteKey', () => {
    register(fakeAdapter('a'));
    expect(getAdapter('a').siteKey).toBe('a');
  });

  it('listAdapters returns all registered adapters', () => {
    register(fakeAdapter('a'));
    register(fakeAdapter('b'));
    expect(listAdapters().map((a) => a.siteKey).sort()).toEqual(['a', 'b']);
  });

  it('throws UnknownSiteError with available list', () => {
    register(fakeAdapter('a'));
    try {
      getAdapter('nope');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownSiteError);
      expect((e as UnknownSiteError).available).toEqual(['a']);
    }
  });

  it('register replaces an existing entry with the same siteKey', () => {
    const a1 = fakeAdapter('a');
    const a2 = fakeAdapter('a');
    register(a1);
    register(a2);
    expect(getAdapter('a')).toBe(a2);
  });
});
