import 'dotenv/config';
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) {
  // eslint-disable-next-line no-console
  console.error('usage: tsx scripts/inspect.ts <url>');
  process.exit(2);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  // eslint-disable-next-line no-console
  console.log(`Inspecting ${url}. Use the DevTools console to iterate selectors. Ctrl+C when done.`);
  // Keep the process alive until SIGINT.
  await new Promise<void>((r) => process.on('SIGINT', () => r()));
  await browser.close();
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('inspect failed:', err);
  process.exit(1);
});
