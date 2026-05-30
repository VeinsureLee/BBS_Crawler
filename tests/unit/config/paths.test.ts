import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  packageRootDir,
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

describe('packageRootDir', () => {
  it('resolves to the BBS_Crawler package root', () => {
    expect(path.basename(packageRootDir())).toBe('BBS_Crawler');
  });
  it('bundledSiteConfigDir sits under the package root', () => {
    expect(bundledSiteConfigDir()).toBe(path.join(packageRootDir(), 'config', 'sites'));
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
  it('uses the package-local .env (base overridable via cwd seam) when present', () => {
    delete process.env.BBS_ENV_FILE;
    const root = mkTmp();
    fs.writeFileSync(path.join(root, '.env'), 'X=1');
    expect(resolveEnvFile({ cwd: root })).toBe(path.join(root, '.env'));
  });
  it('returns null when the package-local .env does not exist', () => {
    delete process.env.BBS_ENV_FILE;
    const root = mkTmp();
    expect(resolveEnvFile({ cwd: root })).toBeNull();
  });
  it('does NOT search parent directories', () => {
    delete process.env.BBS_ENV_FILE;
    const root = mkTmp();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'X=1'); // only the ancestor has .env
    // base = nested, which has no .env of its own → must NOT find the ancestor's
    expect(resolveEnvFile({ cwd: nested })).toBeNull();
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
  it('falls back to <packageRoot>/data when no .env was found', () => {
    delete process.env.DATABASE_PATH;
    expect(resolveDataDir({}, null)).toBe(path.join(packageRootDir(), 'data'));
  });
  it('uses opts.cwd as the base when no .env and cwd is given', () => {
    delete process.env.DATABASE_PATH;
    expect(resolveDataDir({ cwd: '/base' }, null)).toBe(path.join('/base', 'data'));
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
