import type { Page } from 'playwright';

export interface SiteAdapter {
  readonly siteKey: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly requiresAuth: boolean;

  isLoggedIn(page: Page): Promise<boolean>;
  login(page: Page, credentials: LoginCredentials): Promise<void>;

  listSections?(page: Page): Promise<SectionSummary[]>;
  listSectionChildren?(page: Page, sectionKey: string): Promise<SectionChildren>;
  listPinnedThreadIds?(page: Page, boardKey: string): Promise<string[]>;
  listThreads(page: Page, params: ListParams): Promise<ThreadSummary[]>;
  getThread(page: Page, params: GetThreadParams): Promise<Thread>;

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
  maxPages?: number | undefined;
}

export interface SectionSummary {
  sectionKey: string;
  name: string;
  url: string;
}

export interface BoardStats {
  online: number;
  today: number;
  threads: number;
  posts: number;
  snapshotAt: string;
}

export interface BoardSummary {
  boardKey: string;
  name: string;
  url: string;
  moderators: string[];
  stats: BoardStats;
}

export interface SectionChildren {
  subSections: SectionSummary[];
  boards: BoardSummary[];
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
  raw?: Record<string, unknown>;
}

export interface PostAttachment {
  url: string;
  filename?: string;
  kind?: 'image' | 'file';
}
