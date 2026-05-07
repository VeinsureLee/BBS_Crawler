import { describe, it, expect } from 'vitest';
import { _setPoolForTests } from '../../../../src/repository/db';
import { searchCache } from '../../../../src/repository/search';

function makeFakePool(captured: { sql?: string; params?: unknown[] }) {
  return {
    query: (sql: string, params: unknown[]) => {
      captured.sql = sql;
      captured.params = params;
      return Promise.resolve({ rows: [{ id: 1, url: 'u', title: 't', floor: 1, author: 'a', content_text: 'x' }] });
    },
    end: () => Promise.resolve(),
    on: () => {},
    connect: () => { throw new Error('unused'); },
  } as never;
}

describe('searchCache', () => {
  it('builds parameterized FTS query with siteKey filter and limit', async () => {
    const captured: { sql?: string; params?: unknown[] } = {};
    _setPoolForTests(makeFakePool(captured));
    const rows = await searchCache({ keyword: 'foo', siteKey: 's', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(captured.params).toEqual(['s', 'foo', 10]);
    expect(captured.sql).toContain('to_tsvector');
    expect(captured.sql).toContain('plainto_tsquery');
    expect(captured.sql).toContain('LIMIT $3');
  });

  it('passes null siteKey when omitted', async () => {
    const captured: { sql?: string; params?: unknown[] } = {};
    _setPoolForTests(makeFakePool(captured));
    await searchCache({ keyword: 'foo', limit: 5 });
    expect(captured.params).toEqual([null, 'foo', 5]);
  });

  it('defaults limit to 50', async () => {
    const captured: { sql?: string; params?: unknown[] } = {};
    _setPoolForTests(makeFakePool(captured));
    await searchCache({ keyword: 'foo' });
    expect(captured.params).toEqual([null, 'foo', 50]);
  });
});
