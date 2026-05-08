import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'node:readline/promises';
import { loadSiteConfig } from '../../src/core/site-config';
import { saveCredentials, clearCredentials } from '../../src/core/credential-store';

const config = loadSiteConfig('school-bbs');
const ui = config.selectors;

const EXPLORATION_DIR = path.join(process.cwd(), 'exploration');

async function doLogin() {
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  const username = process.env.SCHOOL_BBS_USERNAME;
  const password = process.env.SCHOOL_BBS_PASSWORD;

  if (!baseUrl || !username || !password) {
    console.error('Missing SCHOOL_BBS_BASE_URL / SCHOOL_BBS_USERNAME / SCHOOL_BBS_PASSWORD in .env');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    console.log(`Navigating to ${baseUrl}...`);
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });

    console.log('Filling login form...');
    await page.fill(ui.login.usernameInput, username);
    await page.fill(ui.login.passwordInput, password);

    console.log('Clicking login button...');
    await page.click(ui.login.submitButton);

    console.log('Waiting for navigation...');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // 等待一会儿让页面完全加载
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    console.log(`Final URL after login: ${finalUrl}`);

    // 保存登录后的页面
    let content = await page.content();
    content = content.replace(/charset=["']?GBK["']?/i, 'charset="UTF-8"');
    content = content.replace(/charset=["']?gb2312["']?/i, 'charset="UTF-8"');
    content = content.replace(/></g, '>\n<').replace(/\n\s*\n/g, '\n');

    const filePath = path.join(EXPLORATION_DIR, 'homepage-after-login.html');
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`Saved logged-in homepage to: ${filePath}`);

    const metaPath = filePath.replace(/\.html$/, '.meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      originalUrl: baseUrl,
      finalUrl,
      savedAt: new Date().toISOString(),
      title: await page.title(),
    }, null, 2), 'utf-8');

    // 同时保存 storage state，供后续使用
    const stateDir = process.env.STORAGE_STATE_DIR || './.state';
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    const statePath = path.join(stateDir, 'school-bbs.json');
    await ctx.storageState({ path: statePath });
    console.log(`Saved storage state to: ${statePath}`);

    // Ask whether to remember the password for auto-relogin when cookies expire.
    // Saved encrypted at <STORAGE_STATE_DIR>/school-bbs.credentials.enc, mode 0600.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Remember password for auto-relogin? (y/N): ')).trim().toLowerCase();
    rl.close();
    if (answer === 'y' || answer === 'yes') {
      await saveCredentials('school-bbs', { username, password });
      console.log('Credentials saved (encrypted). Auto-relogin enabled when cookies expire.');
    } else {
      await clearCredentials('school-bbs');
      console.log('Credentials NOT remembered. cookies-only mode (re-run this script when session expires).');
    }

    console.log('Done! You can close the browser now.');
    await new Promise<void>((r) => process.on('SIGINT', () => r()));

  } finally {
    await browser.close();
  }
}

doLogin().catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
