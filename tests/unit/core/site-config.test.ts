import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSiteEntries,
  loadNodeTypes,
  validateConfigConsistency,
  _resetForTests,
} from '../../../src/config/site-config';

function write(file: string, content: string): void {
  fs.writeFileSync(file, content, 'utf-8');
}

describe('loadSiteEntries', () => {
  let tmpDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-config-test-'));
    prevEnv = process.env.SITE_CONFIG_DIR;
    process.env.SITE_CONFIG_DIR = tmpDir;
    _resetForTests();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SITE_CONFIG_DIR;
    else process.env.SITE_CONFIG_DIR = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the entries file is missing', () => {
    expect(loadSiteEntries('school-bbs')).toBeNull();
  });

  it('loads and validates a well-formed entries file', () => {
    write(
      path.join(tmpDir, 'school-bbs.entries.yml'),
      `siteKey: school-bbs
forums:
  - sectionKey: ten
    name: 本站十大
  - sectionKey: club
    name: 社团
    nodeType: forum
`,
    );

    const entries = loadSiteEntries('school-bbs');
    expect(entries).not.toBeNull();
    expect(entries!.siteKey).toBe('school-bbs');
    expect(entries!.forums).toHaveLength(2);
    expect(entries!.forums[0]).toMatchObject({ sectionKey: 'ten', name: '本站十大', nodeType: 'forum' });
    expect(entries!.forums[1]!.nodeType).toBe('forum');
  });

  it('throws on missing required field', () => {
    write(
      path.join(tmpDir, 'school-bbs.entries.yml'),
      `siteKey: school-bbs
forums:
  - sectionKey: ten
`,
    );
    expect(() => loadSiteEntries('school-bbs')).toThrow(/Invalid entries config/);
  });

  it('throws when siteKey field mismatches the filename', () => {
    write(
      path.join(tmpDir, 'school-bbs.entries.yml'),
      `siteKey: other-site
forums: []
`,
    );
    expect(() => loadSiteEntries('school-bbs')).toThrow(/siteKey mismatch/);
  });

  it('throws on duplicate sectionKey', () => {
    write(
      path.join(tmpDir, 'school-bbs.entries.yml'),
      `siteKey: school-bbs
forums:
  - sectionKey: ten
    name: 一号
  - sectionKey: ten
    name: 二号
`,
    );
    expect(() => loadSiteEntries('school-bbs')).toThrow(/Duplicate sectionKey "ten"/);
  });

  it('caches the parsed result on second call', () => {
    const file = path.join(tmpDir, 'school-bbs.entries.yml');
    write(file, `siteKey: school-bbs
forums:
  - sectionKey: ten
    name: A
`);
    const first = loadSiteEntries('school-bbs');
    // Mutate the file — second call should still return cached value.
    write(file, `siteKey: school-bbs
forums: []
`);
    const second = loadSiteEntries('school-bbs');
    expect(second).toBe(first);
  });
});

describe('loadNodeTypes', () => {
  let tmpDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-config-test-'));
    prevEnv = process.env.SITE_CONFIG_DIR;
    process.env.SITE_CONFIG_DIR = tmpDir;
    _resetForTests();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SITE_CONFIG_DIR;
    else process.env.SITE_CONFIG_DIR = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when missing', () => {
    expect(loadNodeTypes('school-bbs')).toBeNull();
  });

  it('loads valid node-types yaml', () => {
    write(
      path.join(tmpDir, 'school-bbs.node-types.yml'),
      `siteKey: school-bbs
nodeTypes:
  forum:
    description: 顶级讨论区
    childTypes: [board]
  board:
    description: 版面
    childTypes: []
`,
    );

    const t = loadNodeTypes('school-bbs');
    expect(t).not.toBeNull();
    expect(t!.nodeTypes['forum']!.description).toBe('顶级讨论区');
    expect(t!.nodeTypes['forum']!.childTypes).toEqual(['board']);
    expect(t!.nodeTypes['board']!.childTypes).toEqual([]);
  });

  it('throws when childType references an undeclared type', () => {
    write(
      path.join(tmpDir, 'school-bbs.node-types.yml'),
      `siteKey: school-bbs
nodeTypes:
  forum:
    description: 顶级
    childTypes: [board, ghost]
  board:
    description: 版面
`,
    );
    expect(() => loadNodeTypes('school-bbs')).toThrow(/unknown child type "ghost"/);
  });
});

describe('validateConfigConsistency', () => {
  let tmpDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-config-test-'));
    prevEnv = process.env.SITE_CONFIG_DIR;
    process.env.SITE_CONFIG_DIR = tmpDir;
    _resetForTests();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SITE_CONFIG_DIR;
    else process.env.SITE_CONFIG_DIR = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is a no-op when either file is missing', () => {
    expect(() => validateConfigConsistency('school-bbs')).not.toThrow();
  });

  it('passes when entries.nodeType values match node-types declarations', () => {
    write(
      path.join(tmpDir, 'school-bbs.entries.yml'),
      `siteKey: school-bbs
forums:
  - sectionKey: ten
    name: 本站十大
    nodeType: forum
`,
    );
    write(
      path.join(tmpDir, 'school-bbs.node-types.yml'),
      `siteKey: school-bbs
nodeTypes:
  forum:
    description: f
    childTypes: []
`,
    );
    expect(() => validateConfigConsistency('school-bbs')).not.toThrow();
  });

  it('throws when an entry references an unknown nodeType', () => {
    write(
      path.join(tmpDir, 'school-bbs.entries.yml'),
      `siteKey: school-bbs
forums:
  - sectionKey: ten
    name: 本站十大
    nodeType: weird
`,
    );
    write(
      path.join(tmpDir, 'school-bbs.node-types.yml'),
      `siteKey: school-bbs
nodeTypes:
  forum:
    description: f
    childTypes: []
`,
    );
    expect(() => validateConfigConsistency('school-bbs')).toThrow(/unknown nodeType "weird"/);
  });
});
