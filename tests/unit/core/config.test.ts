import { describe, it, expect } from 'vitest';
import { parseConfig, credentialEnvKeys, getCredentials } from '../../../../src/core/config';
import { MissingCredentialsError } from '../../../../src/core/errors';

const baseEnv = { DATABASE_URL: 'postgres://u:p@h/db' };

describe('parseConfig', () => {
  it('parses minimal env with defaults', () => {
    const cfg = parseConfig({ ...baseEnv });
    expect(cfg.databaseUrl).toBe('postgres://u:p@h/db');
    expect(cfg.browserHeadless).toBe(true);
    expect(cfg.rateMinIntervalMs).toBe(1500);
    expect(cfg.rateJitterMs).toBe(1000);
    expect(cfg.rateMaxConcurrency).toBe(1);
    expect(cfg.idleTimeoutMs).toBe(300_000);
    expect(cfg.storageStateDir).toBe('./.state');
    expect(cfg.logLevel).toBe('info');
  });

  it('overrides via env values', () => {
    const cfg = parseConfig({
      ...baseEnv,
      BROWSER_HEADLESS: 'false',
      RATE_MIN_INTERVAL_MS: '2500',
      LOG_LEVEL: 'debug',
    });
    expect(cfg.browserHeadless).toBe(false);
    expect(cfg.rateMinIntervalMs).toBe(2500);
    expect(cfg.logLevel).toBe('debug');
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
  });

  it('throws on non-numeric numeric envs', () => {
    expect(() => parseConfig({ ...baseEnv, RATE_MIN_INTERVAL_MS: 'abc' })).toThrow();
  });
});

describe('credentialEnvKeys', () => {
  it('uppercases and replaces - with _', () => {
    expect(credentialEnvKeys('school-bbs')).toEqual({
      username: 'SCHOOL_BBS_USERNAME',
      password: 'SCHOOL_BBS_PASSWORD',
      baseUrl: 'SCHOOL_BBS_BASE_URL',
      loginUrl: 'SCHOOL_BBS_LOGIN_URL',
    });
  });
});

describe('getCredentials', () => {
  it('returns values when present', () => {
    expect(getCredentials('school-bbs', {
      SCHOOL_BBS_USERNAME: 'alice',
      SCHOOL_BBS_PASSWORD: 'pw',
    })).toEqual({ username: 'alice', password: 'pw' });
  });

  it('throws MissingCredentialsError listing missing keys', () => {
    try {
      getCredentials('school-bbs', { SCHOOL_BBS_USERNAME: 'alice' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingCredentialsError);
      expect((e as MissingCredentialsError).missingEnvKeys).toEqual(['SCHOOL_BBS_PASSWORD']);
    }
  });
});
