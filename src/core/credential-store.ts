/**
 * On-disk encrypted credential storage.
 *
 * Threat model: prevent casual inspection of `./.state/` (e.g., another user
 * running `cat`, accidental upload of a backup, screen-sharing). It does NOT
 * resist a determined attacker who can run code as the same OS user — that
 * attacker can derive the key the same way we do.
 *
 * Cipher: AES-256-GCM. Key: sha256 of either `CRED_KEY` env var or a
 * hostname-bound fallback. File layout: base64(iv ‖ tag ‖ ciphertext).
 *
 * File path: `<STORAGE_STATE_DIR>/<siteKey>.credentials.enc` with mode 0600
 * (best-effort on Windows — NTFS ignores unix permission bits).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';

export interface Credentials {
  username: string;
  password: string;
}

const IV_LEN = 12;   // GCM standard nonce length
const TAG_LEN = 16;  // GCM auth tag length

function stateDir(): string {
  return process.env.STORAGE_STATE_DIR ?? './.state';
}

function fileFor(siteKey: string): string {
  return path.join(stateDir(), `${siteKey}.credentials.enc`);
}

function deriveKey(): Buffer {
  const seed = process.env.CRED_KEY ?? `${os.hostname()}::bbs-crawler::v1`;
  return crypto.createHash('sha256').update(seed).digest();
}

export async function saveCredentials(siteKey: string, creds: Credentials): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(creds), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const blob = Buffer.concat([iv, tag, ciphertext]).toString('base64');
  await fs.writeFile(fileFor(siteKey), blob, { mode: 0o600 });
}

export async function loadCredentials(siteKey: string): Promise<Credentials | null> {
  let blob: string;
  try {
    blob = await fs.readFile(fileFor(siteKey), 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }

  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) return null;
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);

  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString('utf-8')) as Credentials;
  return parsed;
}

export async function clearCredentials(siteKey: string): Promise<void> {
  try {
    await fs.unlink(fileFor(siteKey));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
