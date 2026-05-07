import { z } from 'zod';
import { MissingCredentialsError } from './errors';

const boolFromEnv = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}, z.boolean());

const intFromEnv = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}, z.number().int().nonnegative());

const ConfigSchema = z.object({
  // Path to the local PGlite data directory. Defaults to ./.pgdata.
  // (Replaces the old DATABASE_URL — PG is now embedded.)
  PGDATA_DIR: z.string().default('./.pgdata'),
  BROWSER_HEADLESS: boolFromEnv.default(true),
  BROWSER_EXECUTABLE_PATH: z.string().optional(),
  BROWSER_USER_AGENT: z.string().optional(),
  STORAGE_STATE_DIR: z.string().default('./.state'),
  IDLE_TIMEOUT_MS: intFromEnv.default(300_000),
  RATE_MIN_INTERVAL_MS: intFromEnv.default(1_500),
  RATE_JITTER_MS: intFromEnv.default(1_000),
  RATE_MAX_CONCURRENCY: intFromEnv.default(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface AppConfig {
  pgDataDir: string;
  browserHeadless: boolean;
  browserExecutablePath: string | undefined;
  browserUserAgent: string | undefined;
  storageStateDir: string;
  idleTimeoutMs: number;
  rateMinIntervalMs: number;
  rateJitterMs: number;
  rateMaxConcurrency: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function parseConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  const raw = ConfigSchema.parse(env);
  return {
    pgDataDir: raw.PGDATA_DIR,
    browserHeadless: raw.BROWSER_HEADLESS,
    browserExecutablePath: raw.BROWSER_EXECUTABLE_PATH,
    browserUserAgent: raw.BROWSER_USER_AGENT,
    storageStateDir: raw.STORAGE_STATE_DIR,
    idleTimeoutMs: raw.IDLE_TIMEOUT_MS,
    rateMinIntervalMs: raw.RATE_MIN_INTERVAL_MS,
    rateJitterMs: raw.RATE_JITTER_MS,
    rateMaxConcurrency: raw.RATE_MAX_CONCURRENCY,
    logLevel: raw.LOG_LEVEL,
  };
}

export interface CredentialEnvKeys {
  username: string;
  password: string;
  baseUrl: string;
  loginUrl: string;
}

export function credentialEnvKeys(siteKey: string): CredentialEnvKeys {
  const prefix = siteKey.toUpperCase().replace(/-/g, '_');
  return {
    username: `${prefix}_USERNAME`,
    password: `${prefix}_PASSWORD`,
    baseUrl: `${prefix}_BASE_URL`,
    loginUrl: `${prefix}_LOGIN_URL`,
  };
}

export interface SiteCredentials {
  username: string;
  password: string;
  baseUrl?: string | undefined;
  loginUrl?: string | undefined;
}

export function getCredentials(
  siteKey: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): SiteCredentials {
  const keys = credentialEnvKeys(siteKey);
  const missing: string[] = [];
  const username = env[keys.username];
  const password = env[keys.password];
  if (!username) missing.push(keys.username);
  if (!password) missing.push(keys.password);
  if (missing.length) throw new MissingCredentialsError(missing);
  return {
    username: username!,
    password: password!,
    baseUrl: env[keys.baseUrl],
    loginUrl: env[keys.loginUrl],
  };
}
