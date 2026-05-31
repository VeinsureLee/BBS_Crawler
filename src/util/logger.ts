import pino, { type Logger, type StreamEntry } from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

// ----------------------------------------------------------------------------
// Log shadow API
// ----------------------------------------------------------------------------
// Consumers (e.g. MCP) can register a shadow function to receive every log
// entry as a parsed object. Used by MCP to route logs to date/category files.
// The shadow is invoked AFTER pino has serialized the line, so the payload
// reflects post-redaction values.

export type LogShadowLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogShadowEntry {
  /** Pino-style epoch-ms timestamp. */
  time: number;
  level: LogShadowLevel;
  /** Optional category tag (e.g. 'init.pinned'); when the call site passes
   *  `{ category: '...' }` as part of the payload object. */
  category?: string;
  msg: string;
  /** All other fields the call site attached. */
  [key: string]: unknown;
}

const shadows: Array<(entry: LogShadowEntry) => void> = [];

const PINO_LEVEL_TO_NAME: Record<number, LogShadowLevel> = {
  10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal',
};

export function addLogShadow(fn: (entry: LogShadowEntry) => void): () => void {
  shadows.push(fn);
  return () => {
    const idx = shadows.indexOf(fn);
    if (idx >= 0) shadows.splice(idx, 1);
  };
}

const shadowStream = new Writable({
  write(chunk, _encoding, callback) {
    if (shadows.length > 0) {
      try {
        const raw = JSON.parse(chunk.toString()) as Record<string, unknown>;
        const levelNum = typeof raw.level === 'number' ? raw.level : 30;
        const entry: LogShadowEntry = {
          time: typeof raw.time === 'number' ? raw.time : Date.now(),
          level: PINO_LEVEL_TO_NAME[levelNum] ?? 'info',
          msg: typeof raw.msg === 'string' ? raw.msg : '',
          ...raw,
        };
        // Re-set level/time on the spread copy since the spread might have brought
        // in the numeric level / different shape.
        entry.level = PINO_LEVEL_TO_NAME[levelNum] ?? 'info';
        for (const s of shadows) {
          try { s(entry); } catch {}
        }
      } catch {
        // chunk wasn't valid JSON — skip
      }
    }
    callback();
  },
});

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

/**
 * Stdout stream wrapper that re-reads `LOG_STDOUT_DISABLED` on every write.
 * Used by CLI scripts that want to render their own TUI (e.g. init-threads)
 * — they flip the env var at the top of main() and pino quietly drops to a
 * no-op for stdout while continuing to write the file log normally.
 */
const conditionalStdout = {
  write(data: string | Uint8Array): boolean {
    if (process.env.LOG_STDOUT_DISABLED === 'true') return true;
    return process.stdout.write(data);
  },
};

function buildStreams(): StreamEntry[] {
  const streams: StreamEntry[] = [
    { stream: conditionalStdout as unknown as NodeJS.WritableStream },
    // Shadow stream: zero-cost when no shadow registered; receives every log
    // line so consumers (MCP log router) can split by category.
    { stream: shadowStream },
  ];
  if (fileLoggingDisabled()) return streams;

  const filePath = appLogPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
