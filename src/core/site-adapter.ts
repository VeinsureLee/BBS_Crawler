import type { Page } from 'playwright';

export interface SiteAdapter {
  readonly siteKey: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly requiresAuth: boolean;

  isLoggedIn(page: Page): Promise<boolean>;
  login(page: Page, credentials: LoginCredentials): Promise<void>;

  listThreads(page: Page, params: ListParams): Promise<ThreadSummary[]>;
  getThread(page: Page, params: GetThreadParams): Promise<Thread>;
  search(page: Page, params: SearchParams): Promise<ThreadSummary[]>;

  ping?(page: Page): Promise<boolean>;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface ListParams {
  board?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface GetThreadParams {
  url: string;
  maxReplies?: number | undefined;
}

export interface SearchParams {
  keyword: string;
  page?: number | undefined;
}

export interface ThreadSummary {
  url: string;
  title: string;
  author?: string;
  postedAt?: string;
  lastReplyAt?: string;
  replyCount?: number;
  viewCount?: number;
  board?: string;
  raw?: Record<string, unknown>;
}

export interface Thread {
  url: string;
  title: string;
  board?: string;
  posts: Post[];
  fetchedAt: string;
  raw?: Record<string, unknown>;
}

export interface Post {
  floor: number;
  author: string;
  postedAt?: string;
  contentHtml: string;
  contentText: string;
  attachments?: PostAttachment[];
}

export interface PostAttachment {
  url: string;
  filename?: string;
  kind?: 'image' | 'file';
}
