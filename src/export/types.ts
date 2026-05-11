/**
 * Types for exported forum structure.
 */

export interface PinnedThreadInfo {
  title: string;
  url: string;
}

export interface BoardStructure {
  boardKey: string;
  name: string;
  pinnedCount: number;
  pinnedThreads: PinnedThreadInfo[];
}

export interface SectionStructure {
  sectionKey: string;
  name: string;
  subSections: SectionStructure[];
  boards: BoardStructure[];
}

export interface SiteInfo {
  displayName: string;
  baseUrl: string;
}

export interface ForumStructure {
  version: string;
  exportedAt: string;
  siteKey: string;
  site: SiteInfo;
  sections: SectionStructure[];
}
