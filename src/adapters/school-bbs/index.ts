import type { Page } from 'playwright';
import type {
  SiteAdapter,
  LoginCredentials,
  ListParams,
  GetThreadParams,
  SearchParams,
  ThreadSummary,
  Thread,
} from '../../core/site-adapter';
import { register } from '../../core/registry';
import { loadSiteConfig } from '../../core/site-config';

const ui = loadSiteConfig('school-bbs').selectors;

const siteKey = 'school-bbs';
const displayName = 'School BBS';

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.waitForSelector(ui.login.loggedInIndicator, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function login(page: Page, credentials: LoginCredentials): Promise<void> {
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  // Check if already on login page with form
  const hasLoginForm = await page.locator(ui.login.form).count() > 0;
  if (hasLoginForm) {
    await page.fill(ui.login.usernameInput, credentials.username);
    await page.fill(ui.login.passwordInput, credentials.password);
    await page.click(ui.login.submitButton);
    await page.waitForLoadState('networkidle');
  }

  // Verify login success
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    throw new Error('Login failed - could not verify logged-in state');
  }
}

async function listThreads(page: Page, params: ListParams): Promise<ThreadSummary[]> {
  // TODO: implement after analyzing board pages
  return [];
}

async function getThread(page: Page, params: GetThreadParams): Promise<Thread> {
  // TODO: implement after analyzing thread pages
  await page.goto(params.url, { waitUntil: 'networkidle' });
  return {
    url: params.url,
    title: await page.title(),
    posts: [],
    fetchedAt: new Date().toISOString(),
  };
}

async function search(page: Page, params: SearchParams): Promise<ThreadSummary[]> {
  // TODO: implement after analyzing search functionality
  return [];
}

const adapter: SiteAdapter = {
  siteKey,
  displayName,
  baseUrl: process.env.SCHOOL_BBS_BASE_URL || '',
  requiresAuth: true,
  isLoggedIn,
  login,
  listThreads,
  getThread,
  search,
};

register(adapter);
