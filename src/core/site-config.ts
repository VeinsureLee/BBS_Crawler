/**
 * Site config loader.
 *
 * Reads config/sites/<siteKey>.yml, validates with zod, returns typed config.
 * Adapter logic and crawl scripts pull selectors / routes from here so the
 * mapping between site DOM and code lives in one auditable place.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';

const LoginSelectorsSchema = z.object({
  form: z.string(),
  usernameInput: z.string(),
  passwordInput: z.string(),
  submitButton: z.string(),
  loggedInIndicator: z.string(),
});

const SectionSelectorsSchema = z.object({
  boardRowReady: z.string(),
  sectionLinks: z.string(),
});

const BoardSelectorsSchema = z.object({
  threadRowReady: z.string(),
});

const RoutesSchema = z.object({
  section: z.string(),
  board: z.string(),
  thread: z.string(),
});

const CrawlSchema = z.object({
  boardPages: z.number().int().positive(),
  concurrency: z.number().int().positive().default(16),
  requestIntervalMs: z.number().int().nonnegative().default(100),
  structureRequestIntervalMs: z.number().int().nonnegative().default(1500),
  pageTurnIntervalMs: z.number().int().nonnegative().default(400),
  maxPinnedThreadPages: z.number().int().positive().default(10),
});

const SiteConfigSchema = z.object({
  siteKey: z.string().min(1),
  displayName: z.string().min(1),
  routes: RoutesSchema,
  selectors: z.object({
    login: LoginSelectorsSchema,
    section: SectionSelectorsSchema,
    board: BoardSelectorsSchema,
  }),
  crawl: CrawlSchema,
});

export type SiteConfig = z.infer<typeof SiteConfigSchema>;

const CONFIG_DIR = path.join(process.cwd(), 'config', 'sites');

const cache = new Map<string, SiteConfig>();

export function loadSiteConfig(siteKey: string): SiteConfig {
  const cached = cache.get(siteKey);
  if (cached) return cached;

  const file = path.join(CONFIG_DIR, `${siteKey}.yml`);
  if (!fs.existsSync(file)) {
    throw new Error(`Site config not found: ${file}`);
  }

  const raw = yaml.load(fs.readFileSync(file, 'utf-8'));
  const parsed = SiteConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid site config ${file}:\n${parsed.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }

  if (parsed.data.siteKey !== siteKey) {
    throw new Error(
      `Site config siteKey mismatch: file is ${siteKey}.yml but siteKey field is "${parsed.data.siteKey}"`,
    );
  }

  cache.set(siteKey, parsed.data);
  return parsed.data;
}

/**
 * Build an absolute URL for a given route.
 * Substitutes {placeholder} tokens from `params`.
 */
export function buildRouteUrl(
  baseUrl: string,
  template: string,
  params: Record<string, string>,
): string {
  const filled = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing route param "${key}" for template "${template}"`);
    }
    return value;
  });
  return baseUrl.replace(/\/+$/, '') + filled;
}
