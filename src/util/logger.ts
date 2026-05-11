import pino, { type Logger, type StreamEntry } from 'pino';
import fs from 'node:fs';
import path from 'node:path';

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

/** Resolve the path for today's app log file. UTC date so it's stable across timezones. */
export function appLogPath(logDir: string = process.env.LOG_DIR ?? './.logs'): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(logDir, 'app', `app-${today}.log`);
}

function fileLoggingDisabled(): boolean {
  return (
    process.env.LOG_FILE_DISABLED === 'true' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true'
  );
}

function buildStreams(): StreamEntry[] {
  const streams: StreamEntry[] = [{ stream: process.stdout }];
  if (fileLoggingDisabled()) return streams;

  const filePath = appLogPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // sync: true avoids "sonic boom is not ready yet" errors when the process
  // exits very quickly (e.g., CLI scripts with arg-validation early-exit).
  // Performance cost per log line is negligible for our scale.
  streams.push({ stream: pino.destination({ dest: filePath, sync: true }) });
  return streams;
}

export const logger: Logger = pino(
  {
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
  },
  pino.multistream(buildStreams()),
);
