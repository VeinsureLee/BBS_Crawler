import pino, { type Logger } from 'pino';

const secrets = new Set<string>();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function addRedactedSecret(secret: string): void {
  if (!secret || !secret.trim()) return;
  secrets.add(secret);
}

export function redactString(input: string): string {
  if (secrets.size === 0) return input;
  let out = input;
  for (const s of secrets) {
    out = out.replace(new RegExp(escapeRegex(s), 'g'), '***');
  }
  return out;
}

/** Test-only helper. Do not call in production code. */
export function _resetForTests(): void {
  secrets.clear();
}

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    log(obj) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = typeof v === 'string' ? redactString(v) : v;
      }
      return out;
    },
  },
});
