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
} from '../../../src/config/paths';

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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-'));
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'X=1');
    expect(resolveEnvFile({ cwd: nested })).toBe(path.join(root, '.env'));
  });
  it('returns null when nothing is found searching upward', () => {
    delete process.env.BBS_ENV_FILE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-'));
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
