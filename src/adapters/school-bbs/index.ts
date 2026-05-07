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
import { selectors } from './selectors';

const siteKey = 'school-bbs';
const displayName = 'School BBS';

async function isLoggedIn(page: Page): Promise<boolean> {
  // TODO: implement after analyzing login state
  try {
    await page.waitForSelector(selectors.userInfo, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function login(page: Page, credentials: LoginCredentials): Promise<void> {
  // TODO: implement after analyzing login page
  const baseUrl = process.env.SCHOOL_BBS_BASE_URL;
  if (!baseUrl) throw new Error('SCHOOL_BBS_BASE_URL not set');

  const loginUrl = process.env.SCHOOL_BBS_LOGIN_URL || `${baseUrl}/login`;
  await page.goto(loginUrl, { waitUntil: 'networkidle' });

  // Placeholder - update selectors after analysis
  await page.fill(selectors.usernameInput, credentials.username);
  await page.fill(selectors.passwordInput, credentials.password);
  await page.click(selectors.submitButton);
  await page.waitForLoadState('networkidle');
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
