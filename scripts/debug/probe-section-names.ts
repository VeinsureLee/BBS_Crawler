/// <reference types="node" />
/**
 * One-shot probe: visit /section/0 .. /section/12, dump several candidate
 * places where the section's canonical name might live in the DOM.
 *
 * After you see the output we can decide which selector to bake into
 * adapter.listSections so it stops trusting the (lying) homepage sidebar.
 *
 * Usage: npx tsx scripts/debug/probe-section-names.ts
 */
import 'dotenv/config';
import '../../src/adapters/index';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Page } from 'playwright';
import { parseConfig } from '../../src/core/config';
import { buildRouteUrl, loadSiteConfig } from '../../src/core/site-config';

const SITE_KEY = 'school-bbs';
const MAX_INDEX = 12; // probe /section/0 .. /section/12

async function probeOne(page: Page, sectionKey: string, baseUrl: string) {
  const route = loadSiteConfig(SITE_KEY).routes.section;
  const url = buildRouteUrl(baseUrl, route, { key: sectionKey });
  await page.goto('about:blank');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    return { sectionKey, error: `goto failed: ${(e as Error).message}` };
  }

  // Try to wait for board rows but don't fail the probe if it times out.
  try {
    await page.waitForSelector('td.title_1', { timeout: 5000 });
  } catch {
    // empty section is fine — we still want to dump what the page contains
  }
  // small grace for any extra DOM
  await page.waitForTimeout(300);

  // No inner function declarations inside page.evaluate — tsx injects a
  // __name helper for typed arrows, which is undefined in the page context.
  // Use a selector list + inline loop instead.
  const candidates = await page.evaluate(() => {
    const out: Record<string, string> = {};
    out['document.title'] = (typeof document !== 'undefined' && document.title) || '';
    const SELS = [
      'h1',
      'h2',
      'h3',
      '.b-head .n-left',
      '.b-head .n-right',
      '.s-head',
      '.s-name',
      '.section-title',
      '.crumb',
      '.breadcrumb',
      '#main h1, #main h2',
      '.current',
    ];
    for (let i = 0; i < SELS.length; i++) {
      const sel = SELS[i]!;
      const el = document.querySelector(sel);
      out[sel] = el && el.textContent ? el.textContent.trim() : '';
    }

    const rows = document.querySelectorAll('table.board-list tbody tr');
    const firstBoards: string[] = [];
    const lim = rows.length < 3 ? rows.length : 3;
    for (let i = 0; i < lim; i++) {
      const a = rows[i]!.querySelector('td.title_1 a');
      if (a && a.textContent) firstBoards.push(a.textContent.trim());
    }
    out['boards_loaded'] = String(rows.length);
    out['first_3_boards'] = firstBoards.join(' | ');
    return out;
  });

  return { sectionKey, url, ...candidates };
}

async function main() {
  const cfg = parseConfig(process.env);
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set in .env');

  const statePath = path.join(cfg.storageStateDir, `${SITE_KEY}.json`);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Storage state not found at ${statePath}. Run \`npm run login\` first.`);
  }

  const browser = await chromium.launch({
    headless: cfg.browserHeadless,
    ...(cfg.browserExecutablePath ? { executablePath: cfg.browserExecutablePath } : {}),
  });
  const ctx = await browser.newContext({
    storageState: statePath,
    ...(cfg.browserUserAgent ? { userAgent: cfg.browserUserAgent } : {}),
  });
  const page = await ctx.newPage();

  console.log(`probing /section/0 .. /section/${MAX_INDEX} on ${baseUrl}\n`);

  try {
    for (let i = 0; i <= MAX_INDEX; i++) {
      const r = await probeOne(page, String(i), baseUrl);
      console.log(`=== /section/${i} ===`);
      for (const [k, v] of Object.entries(r)) {
        if (k === 'sectionKey') continue;
        // Long ones truncate
        const s = String(v).replace(/\s+/g, ' ').slice(0, 160);
        console.log(`  ${k.padEnd(28)} : ${s}`);
      }
      console.log();
    }
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
