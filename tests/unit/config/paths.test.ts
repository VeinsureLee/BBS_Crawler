import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findEnvFileUpward, resolveDataDir, resolveSiteConfigDir } from '../../../src/config/paths';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe('findEnvFileUpward', () => {
  it('finds .env in an ancestor directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-'));
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'X=1');
    expect(findEnvFileUpward(nested)).toBe(path.join(root, '.env'));
  });
  it('returns null when no .env exists up to fs root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-'));
    expect(findEnvFileUpward(root)).toBeNull();
  });
});

describe('resolveDataDir', () => {
  it('prefers explicit opts.dataDir', () => {
    expect(resolveDataDir({ dataDir: '/x/y' }, '/some/.env')).toBe('/x/y');
  });
  it('falls back to <dir of .env>/data', () => {
    delete process.env.DATABASE_PATH;
    expect(resolveDataDir({}, path.join('/repo', '.env'))).toBe(path.join('/repo', 'data'));
  });
});

describe('resolveSiteConfigDir', () => {
  it('prefers explicit opts.siteConfigDir', () => {
    expect(resolveSiteConfigDir({ siteConfigDir: '/cfg' })).toBe('/cfg');
  });
});
