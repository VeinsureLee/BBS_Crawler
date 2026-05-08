import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

function getLaunchOptions() {
  const opts: any = {};
  if (process.env.BROWSER_EXECUTABLE_PATH) {
    opts.executablePath = process.env.BROWSER_EXECUTABLE_PATH;
  }
  return opts;
}

const EXPLORATION_DIR = path.join(process.cwd(), 'exploration');

// Ensure exploration directory exists
if (!fs.existsSync(EXPLORATION_DIR)) {
  fs.mkdirSync(EXPLORATION_DIR, { recursive: true });
}

const command = process.argv[2];
const url = process.argv[3];

if (!command) {
  console.error(`
Usage:
  # Save page HTML to exploration/
  tsx scripts/explore.ts save <url> [filename]
  tsx scripts/explore.ts save-school-bbs [filename]  (uses SCHOOL_BBS_BASE_URL)

  # Open page in browser for inspection
  tsx scripts/explore.ts inspect <url>
  tsx scripts/explore.ts inspect-school-bbs        (uses SCHOOL_BBS_BASE_URL)

  # List saved snapshots
  tsx scripts/explore.ts list
  `);
  process.exit(2);
}

function sanitizeFilename(input: string): string {
  return input
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9-_./]/g, '_')
    .slice(0, 100);
}

async function savePage(pageUrl: string, filename?: string) {
  const browser = await chromium.launch({ headless: true, ...getLaunchOptions() });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    console.log(`Navigating to ${pageUrl}...`);
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });

    let content = await page.content();
    const finalUrl = page.url();

    // 将 charset 改为 UTF-8 避免乱码
    content = content.replace(/charset=["']?GBK["']?/i, 'charset="UTF-8"');
    content = content.replace(/charset=["']?gb2312["']?/i, 'charset="UTF-8"');

    // 简单格式化：在标签间换行
    content = content.replace(/></g, '>\n<').replace(/\n\s*\n/g, '\n');

    const targetFilename = filename || `${sanitizeFilename(finalUrl)}.html`;
    const filePath = path.join(EXPLORATION_DIR, targetFilename);

    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`Saved to: ${filePath}`);

    // Also save a metadata file with context
    const metaPath = filePath.replace(/\.html$/, '.meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      originalUrl: pageUrl,
      finalUrl,
      savedAt: new Date().toISOString(),
      title: await page.title(),
    }, null, 2), 'utf-8');

  } finally {
    await browser.close();
  }
}

async function inspectPage(pageUrl: string) {
  const browser = await chromium.launch({ headless: false, ...getLaunchOptions() });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });
  console.log(`Inspecting ${pageUrl}. Use DevTools. Ctrl+C to exit.`);

  await new Promise<void>((r) => process.on('SIGINT', () => r()));
  await browser.close();
}

function listSnapshots() {
  const files = fs.readdirSync(EXPLORATION_DIR)
    .filter(f => f.endsWith('.html') || f.endsWith('.meta.json'))
    .sort();

  if (files.length === 0) {
    console.log('No snapshots saved yet.');
    return;
  }

  console.log('Saved snapshots:');
  for (const f of files) {
    const stat = fs.statSync(path.join(EXPLORATION_DIR, f));
    console.log(`  ${f} (${(stat.size / 1024).toFixed(1)} KB)`);
  }
}

(async () => {
  switch (command) {
    case 'save':
      if (!url) {
        console.error('Missing url: tsx scripts/explore.ts save <url> [filename]');
        process.exit(2);
      }
      await savePage(url, process.argv[4]);
      break;
    case 'save-school-bbs':
      if (!process.env.SCHOOL_BBS_BASE_URL) {
        console.error('SCHOOL_BBS_BASE_URL not set in .env');
        process.exit(2);
      }
      await savePage(process.env.SCHOOL_BBS_BASE_URL, process.argv[3] || 'homepage.html');
      break;
    case 'inspect':
      if (!url) {
        console.error('Missing url: tsx scripts/explore.ts inspect <url>');
        process.exit(2);
      }
      await inspectPage(url);
      break;
    case 'inspect-school-bbs':
      if (!process.env.SCHOOL_BBS_BASE_URL) {
        console.error('SCHOOL_BBS_BASE_URL not set in .env');
        process.exit(2);
      }
      await inspectPage(process.env.SCHOOL_BBS_BASE_URL);
      break;
    case 'list':
      listSnapshots();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(2);
  }
})().catch((err) => {
  console.error('explore failed:', err);
  process.exit(1);
});
