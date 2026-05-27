import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findEnvFileUpward,
  resolveDataDir,
  resolveEnvFile,
  resolveSiteConfigDir,
  bundledSiteConfigDir,
  loadAndResolvePaths,
} from '../../../src/config/paths';

const saved = { ...process.env };
const tmpDirs: string[] = [];

/** mkdtemp wrapper that registers the dir for afterEach cleanup. */
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  process.env = { ...saved };
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe('findEnvFileUpward', () => {
  it('finds .env in an ancestor directory', () => {
    const root = mkTmp();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'X=1');
    expect(findEnvFileUpward(nested)).toBe(path.join(root, '.env'));
  });
  it('returns null when no .env exists up to fs root', () => {
    const root = mkTmp();
    expect(findEnvFileUpward(root)).toBeNull();
  });
});

describe('resolveEnvFile', () => {
  it('prefers explicit opts.envFile', () => {
    process.env.BBS_ENV_FILE = '/should/not/win/.env';
    expect(resolveEnvFile({ envFile: '/explicit/.env' })).toBe('/explicit/.env');
  });
  it('falls back to process.env.BBS_ENV_FILE when no opts.envFile', () => {
    process.env.BBS_ENV_FILE = '/from/env/.env';
    expect(resolveEnvFile({})).toBe('/from/env/.env');
  });
  it('searches upward from opts.cwd when neither opts.envFile nor BBS_ENV_FILE set', () => {
    delete process.env.BBS_ENV_FILE;
    const root = mkTmp();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'X=1');
    expect(resolveEnvFile({ cwd: nested })).toBe(path.join(root, '.env'));
  });
  it('returns null when nothing is found searching upward', () => {
    delete process.env.BBS_ENV_FILE;
    const root = mkTmp();
    expect(resolveEnvFile({ cwd: root })).toBeNull();
  });
});

describe('resolveDataDir', () => {
  it('prefers explicit opts.dataDir', () => {
    expect(resolveDataDir({ dataDir: '/x/y' }, '/some/.env')).toBe('/x/y');
  });
  it('uses process.env.DATABASE_PATH over the .env-derived path', () => {
    process.env.DATABASE_PATH = '/from/env/data';
    expect(resolveDataDir({}, path.join('/repo', '.env'))).toBe('/from/env/data');
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
  it('uses process.env.SITE_CONFIG_DIR over the bundled dir', () => {
    process.env.SITE_CONFIG_DIR = '/from/env/sites';
    expect(resolveSiteConfigDir({})).toBe('/from/env/sites');
  });
  it('falls back to the bundled config/sites dir', () => {
    delete process.env.SITE_CONFIG_DIR;
    const resolved = resolveSiteConfigDir({});
    expect(resolved).toBe(bundledSiteConfigDir());
    expect(resolved.endsWith(path.join('config', 'sites'))).toBe(true);
  });
});

describe('loadAndResolvePaths', () => {
  it('does not override an already-set process.env value when loading .env', () => {
    const dir = mkTmp();
    process.env.SOMEKEY = 'preset';
    fs.writeFileSync(path.join(dir, '.env'), 'SOMEKEY=from-dotenv');
    loadAndResolvePaths({ cwd: dir, siteConfigDir: '/cfg' });
    // dotenv must not override an env var that already had a value.
    expect(process.env.SOMEKEY).toBe('preset');
  });

  it('unconditionally writes SITE_CONFIG_DIR to the resolved value', () => {
    const dir = mkTmp();
    process.env.SITE_CONFIG_DIR = '/stale/value';
    const result = loadAndResolvePaths({ cwd: dir, siteConfigDir: '/explicit/sites' });
    expect(result.siteConfigDir).toBe('/explicit/sites');
    expect(process.env.SITE_CONFIG_DIR).toBe('/explicit/sites');
  });

  it('writes DATABASE_PATH only when it is not already set', () => {
    const dir = mkTmp();
    delete process.env.DATABASE_PATH;
    const result = loadAndResolvePaths({ cwd: dir, siteConfigDir: '/cfg', dataDir: '/resolved/data' });
    expect(result.dataDir).toBe('/resolved/data');
    expect(process.env.DATABASE_PATH).toBe('/resolved/data');
  });

  it('does not overwrite a preset DATABASE_PATH', () => {
    const dir = mkTmp();
    process.env.DATABASE_PATH = '/preset';
    loadAndResolvePaths({ cwd: dir, siteConfigDir: '/cfg', dataDir: '/resolved/data' });
    expect(process.env.DATABASE_PATH).toBe('/preset');
  });

  it('returns an object with envFile, dataDir and siteConfigDir', () => {
    const dir = mkTmp();
    delete process.env.DATABASE_PATH;
    const result = loadAndResolvePaths({ cwd: dir, siteConfigDir: '/cfg' });
    expect(result).toHaveProperty('envFile');
    expect(result).toHaveProperty('dataDir');
    expect(result).toHaveProperty('siteConfigDir');
    expect(result.siteConfigDir).toBe('/cfg');
    // No .env in the fresh tmp dir, so envFile resolves to null.
    expect(result.envFile).toBeNull();
    expect(result.dataDir).toBe(path.join(dir, 'data'));
  });
});
