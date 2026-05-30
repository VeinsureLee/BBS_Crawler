import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

export interface PathOptions {
  envFile?: string | undefined;
  dataDir?: string | undefined;
  siteConfigDir?: string | undefined;
  /**
   * Test seam: override the base directory used to locate the package-local
   * `.env` and the default data dir. Production leaves this unset and uses the
   * crawler package root.
   */
  cwd?: string | undefined;
}

export interface ResolvedPaths {
  envFile: string | null;
  dataDir: string;
  siteConfigDir: string;
}

/**
 * The crawler package root (the BBS_Crawler directory), resolved relative to
 * this module. Works in both dev (src/config/paths.ts) and built
 * (dist/config/paths.js): both live two levels below the package root.
 */
export function packageRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

/** crawler package's bundled config/sites dir. */
export function bundledSiteConfigDir(): string {
  return path.join(packageRootDir(), 'config', 'sites');
}

/**
 * Resolve which `.env` to load. The crawler only ever uses its OWN
 * package-local `.env` — it does NOT search parent directories. Precedence:
 *   explicit `opts.envFile` > `BBS_ENV_FILE` env > `<packageRoot>/.env`.
 * Returns null if no such file exists.
 */
export function resolveEnvFile(opts: PathOptions): string | null {
  if (opts.envFile) return opts.envFile;
  if (process.env.BBS_ENV_FILE) return process.env.BBS_ENV_FILE;
  const base = opts.cwd ?? packageRootDir();
  const candidate = path.join(base, '.env');
  return fs.existsSync(candidate) ? candidate : null;
}

export function resolveSiteConfigDir(opts: PathOptions): string {
  if (opts.siteConfigDir) return opts.siteConfigDir;
  if (process.env.SITE_CONFIG_DIR) return process.env.SITE_CONFIG_DIR;
  return bundledSiteConfigDir();
}

/**
 * Resolve the data directory. The env var read here (and written by
 * `loadAndResolvePaths`) is `DATABASE_PATH` — the same name `parseConfig`
 * consumes; `dataDir` is just our alias for it. Precedence: explicit
 * `opts.dataDir` > `DATABASE_PATH` env > `<dir of .env>/data` (falling back to
 * `<packageRoot>/data` when no `.env` was found).
 */
export function resolveDataDir(opts: PathOptions, envFile: string | null): string {
  if (opts.dataDir) return opts.dataDir;
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  const base = envFile ? path.dirname(envFile) : (opts.cwd ?? packageRootDir());
  return path.join(base, 'data');
}

/**
 * Load the package-local `.env` (dotenv does NOT override already-set
 * process.env) then resolve all paths and export them back to process.env so
 * existing consumers (site-config, parseConfig) pick them up.
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
