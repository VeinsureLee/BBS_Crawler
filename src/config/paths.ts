import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

export interface PathOptions {
  envFile?: string | undefined;
  dataDir?: string | undefined;
  siteConfigDir?: string | undefined;
  cwd?: string | undefined; // test seam
}

export interface ResolvedPaths {
  envFile: string | null;
  dataDir: string;
  siteConfigDir: string;
}

/** Walk up from `start` looking for a `.env`. Returns its absolute path or null. */
export function findEnvFileUpward(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** crawler package's bundled config/sites dir, resolved relative to this module. */
export function bundledSiteConfigDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'config', 'sites');
}

export function resolveEnvFile(opts: PathOptions): string | null {
  if (opts.envFile) return opts.envFile;
  if (process.env.BBS_ENV_FILE) return process.env.BBS_ENV_FILE;
  return findEnvFileUpward(opts.cwd ?? process.cwd());
}

export function resolveSiteConfigDir(opts: PathOptions): string {
  if (opts.siteConfigDir) return opts.siteConfigDir;
  if (process.env.SITE_CONFIG_DIR) return process.env.SITE_CONFIG_DIR;
  return bundledSiteConfigDir();
}

export function resolveDataDir(opts: PathOptions, envFile: string | null): string {
  if (opts.dataDir) return opts.dataDir;
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  const base = envFile ? path.dirname(envFile) : (opts.cwd ?? process.cwd());
  return path.join(base, 'data');
}

/**
 * Load `.env` (dotenv does NOT override already-set process.env) then resolve
 * all paths and export them back to process.env so existing consumers
 * (site-config, parseConfig) pick them up.
 */
export function loadAndResolvePaths(opts: PathOptions = {}): ResolvedPaths {
  const envFile = resolveEnvFile(opts);
  if (envFile && fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
  }
  const siteConfigDir = resolveSiteConfigDir(opts);
  const dataDir = resolveDataDir(opts, envFile);
  process.env.SITE_CONFIG_DIR = siteConfigDir;
  if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = dataDir;
  return { envFile, dataDir, siteConfigDir };
}
