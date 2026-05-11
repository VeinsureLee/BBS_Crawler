/**
 * Site config loader.
 *
 * Reads YAML files under config/sites/, validates with zod, returns typed
 * config objects. Adapter logic and crawl scripts pull selectors / routes /
 * structure entries from here so the mapping between site DOM and code lives
 * in one auditable place.
 *
 * Three loaders, each cached in-memory after first read:
 *   - loadSiteConfig(siteKey)   ← <siteKey>.yml          (selectors + crawl params)
 *   - loadSiteEntries(siteKey)  ← <siteKey>.entries.yml  (top-level forum list)
 *   - loadNodeTypes(siteKey)    ← <siteKey>.node-types.yml (node shape declarations)
 *
 * The latter two return null when the file is missing — callers can fall back
 * to legacy crawl-based discovery.
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
  maxRetryPasses: z.number().int().nonnegative().default(3),
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

// --- entries.yml ----------------------------------------------------------

const ForumEntrySchema = z.object({
  sectionKey: z.string().min(1),
  name: z.string().min(1),
  /** Optional reference into node-types.yml; defaults to "forum". */
  nodeType: z.string().min(1).default('forum'),
});

const SiteEntriesSchema = z.object({
  siteKey: z.string().min(1),
  forums: z.array(ForumEntrySchema),
});

export type ForumEntry = z.infer<typeof ForumEntrySchema>;
export type SiteEntries = z.infer<typeof SiteEntriesSchema>;

// --- node-types.yml -------------------------------------------------------

const NodeTypeDefSchema = z.object({
  description: z.string().min(1),
  /** Allowed child node-type names. Empty = leaf. */
  childTypes: z.array(z.string().min(1)).default([]),
});

const NodeTypesSchema = z.object({
  siteKey: z.string().min(1),
  nodeTypes: z.record(z.string(), NodeTypeDefSchema),
});

export type NodeTypeDef = z.infer<typeof NodeTypeDefSchema>;
export type NodeTypes = z.infer<typeof NodeTypesSchema>;

// --- shared internals -----------------------------------------------------

/**
 * Resolved on every call so tests can override via SITE_CONFIG_DIR env var.
 * Production reads the default ./config/sites/.
 */
function getConfigDir(): string {
  return process.env.SITE_CONFIG_DIR ?? path.join(process.cwd(), 'config', 'sites');
}

const siteConfigCache = new Map<string, SiteConfig>();
const siteEntriesCache = new Map<string, SiteEntries | null>();
const nodeTypesCache = new Map<string, NodeTypes | null>();

function readYamlOrThrow(file: string): unknown {
  return yaml.load(fs.readFileSync(file, 'utf-8'));
}

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

/**
 * Test-only helper. Drops all cached configs so the next call re-reads from
 * disk. Production code should never need this.
 */
export function _resetForTests(): void {
  siteConfigCache.clear();
  siteEntriesCache.clear();
  nodeTypesCache.clear();
}

// --- public loaders -------------------------------------------------------

export function loadSiteConfig(siteKey: string): SiteConfig {
  const cached = siteConfigCache.get(siteKey);
  if (cached) return cached;

  const file = path.join(getConfigDir(),`${siteKey}.yml`);
  if (!fs.existsSync(file)) {
    throw new Error(`Site config not found: ${file}`);
  }

  const raw = readYamlOrThrow(file);
  const parsed = SiteConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid site config ${file}:\n${formatZodIssues(parsed.error.issues)}`);
  }

  if (parsed.data.siteKey !== siteKey) {
    throw new Error(
      `Site config siteKey mismatch: file is ${siteKey}.yml but siteKey field is "${parsed.data.siteKey}"`,
    );
  }

  siteConfigCache.set(siteKey, parsed.data);
  return parsed.data;
}

/**
 * Load <siteKey>.entries.yml. Returns null when the file does not exist —
 * caller can fall back to crawling the homepage for the legacy path.
 *
 * The file is the **source of truth** for top-level forums when present.
 */
export function loadSiteEntries(siteKey: string): SiteEntries | null {
  if (siteEntriesCache.has(siteKey)) return siteEntriesCache.get(siteKey)!;

  const file = path.join(getConfigDir(),`${siteKey}.entries.yml`);
  if (!fs.existsSync(file)) {
    siteEntriesCache.set(siteKey, null);
    return null;
  }

  const raw = readYamlOrThrow(file);
  const parsed = SiteEntriesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid entries config ${file}:\n${formatZodIssues(parsed.error.issues)}`);
  }
  if (parsed.data.siteKey !== siteKey) {
    throw new Error(
      `Entries config siteKey mismatch: file is ${siteKey}.entries.yml but siteKey field is "${parsed.data.siteKey}"`,
    );
  }

  // Detect duplicate sectionKey entries early.
  const seen = new Set<string>();
  for (const f of parsed.data.forums) {
    if (seen.has(f.sectionKey)) {
      throw new Error(`Duplicate sectionKey "${f.sectionKey}" in ${file}`);
    }
    seen.add(f.sectionKey);
  }

  siteEntriesCache.set(siteKey, parsed.data);
  return parsed.data;
}

/**
 * Load <siteKey>.node-types.yml. Returns null when the file does not exist.
 * This file documents node shapes (forum / sub_forum / board / thread) and
 * their child-type relationships. Validation only — does not drive parsing
 * yet (Phase 3+).
 */
export function loadNodeTypes(siteKey: string): NodeTypes | null {
  if (nodeTypesCache.has(siteKey)) return nodeTypesCache.get(siteKey)!;

  const file = path.join(getConfigDir(),`${siteKey}.node-types.yml`);
  if (!fs.existsSync(file)) {
    nodeTypesCache.set(siteKey, null);
    return null;
  }

  const raw = readYamlOrThrow(file);
  const parsed = NodeTypesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid node-types config ${file}:\n${formatZodIssues(parsed.error.issues)}`);
  }
  if (parsed.data.siteKey !== siteKey) {
    throw new Error(
      `Node-types config siteKey mismatch: file is ${siteKey}.node-types.yml but siteKey field is "${parsed.data.siteKey}"`,
    );
  }

  // Validate childTypes references stay inside the declared set.
  const declared = new Set(Object.keys(parsed.data.nodeTypes));
  for (const [typeName, def] of Object.entries(parsed.data.nodeTypes)) {
    for (const child of def.childTypes) {
      if (!declared.has(child)) {
        throw new Error(
          `Node-type "${typeName}" references unknown child type "${child}" in ${file}`,
        );
      }
    }
  }

  nodeTypesCache.set(siteKey, parsed.data);
  return parsed.data;
}

/**
 * Cross-file consistency check. Verifies every entry's nodeType exists in
 * node-types.yml. Throws on mismatch. Call once at init startup.
 */
export function validateConfigConsistency(siteKey: string): void {
  const entries = loadSiteEntries(siteKey);
  const types = loadNodeTypes(siteKey);
  if (!entries || !types) return; // nothing to cross-check yet

  const declared = new Set(Object.keys(types.nodeTypes));
  for (const f of entries.forums) {
    if (!declared.has(f.nodeType)) {
      throw new Error(
        `entries.yml entry "${f.sectionKey}" references unknown nodeType "${f.nodeType}" — declared types: [${[...declared].join(', ')}]`,
      );
    }
  }
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
