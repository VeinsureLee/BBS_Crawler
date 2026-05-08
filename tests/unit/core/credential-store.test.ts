import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { saveCredentials, loadCredentials, clearCredentials } from '../../../src/core/credential-store';

let tmp: string;
let prevStateDir: string | undefined;
let prevCredKey: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bbs-creds-'));
  prevStateDir = process.env.STORAGE_STATE_DIR;
  prevCredKey = process.env.CRED_KEY;
  process.env.STORAGE_STATE_DIR = tmp;
  process.env.CRED_KEY = 'test-key-fixed-for-determinism';
});

afterEach(async () => {
  if (prevStateDir === undefined) delete process.env.STORAGE_STATE_DIR;
  else process.env.STORAGE_STATE_DIR = prevStateDir;
  if (prevCredKey === undefined) delete process.env.CRED_KEY;
  else process.env.CRED_KEY = prevCredKey;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('credential-store', () => {
  it('returns null when no file exists', async () => {
    expect(await loadCredentials('school-bbs')).toBeNull();
  });

  it('round-trips saved credentials', async () => {
    await saveCredentials('school-bbs', { username: 'alice', password: 'p@ssw0rd!' });
    expect(await loadCredentials('school-bbs')).toEqual({ username: 'alice', password: 'p@ssw0rd!' });
  });

  it('persisted file is not human-readable plaintext', async () => {
    await saveCredentials('school-bbs', { username: 'alice', password: 'secret123' });
    const raw = await fs.readFile(path.join(tmp, 'school-bbs.credentials.enc'), 'utf-8');
    expect(raw).not.toContain('alice');
    expect(raw).not.toContain('secret123');
  });

  it('stores per-siteKey separately', async () => {
    await saveCredentials('site-a', { username: 'ua', password: 'pa' });
    await saveCredentials('site-b', { username: 'ub', password: 'pb' });
    expect(await loadCredentials('site-a')).toEqual({ username: 'ua', password: 'pa' });
    expect(await loadCredentials('site-b')).toEqual({ username: 'ub', password: 'pb' });
  });

  it('clearCredentials removes the file', async () => {
    await saveCredentials('school-bbs', { username: 'u', password: 'p' });
    await clearCredentials('school-bbs');
    expect(await loadCredentials('school-bbs')).toBeNull();
  });

  it('clearCredentials is a no-op when file already absent', async () => {
    await expect(clearCredentials('never-existed')).resolves.toBeUndefined();
  });

  it('decryption fails when CRED_KEY changes', async () => {
    await saveCredentials('school-bbs', { username: 'u', password: 'p' });
    process.env.CRED_KEY = 'a-different-key';
    await expect(loadCredentials('school-bbs')).rejects.toThrow();
  });

  it('produces different ciphertext for the same plaintext (random IV)', async () => {
    await saveCredentials('school-bbs', { username: 'u', password: 'p' });
    const a = await fs.readFile(path.join(tmp, 'school-bbs.credentials.enc'), 'utf-8');
    await saveCredentials('school-bbs', { username: 'u', password: 'p' });
    const b = await fs.readFile(path.join(tmp, 'school-bbs.credentials.enc'), 'utf-8');
    expect(a).not.toEqual(b);
  });
});
