/**
 * Tail the most recent app log and render progress.tick / progress.final
 * payloads as a multi-line block that refreshes in place.
 *
 * - TTY mode (default): block re-renders on every tick (ANSI cursor-up + clear).
 *   The block shows a summary line + one line per forum.
 * - Non-TTY (e.g. piped to file): falls back to plain line-mode (one row per
 *   tick), so logs/captures stay parseable.
 *
 * Usage:
 *   npm run tail:progress              # tail .logs/app/app-<today>.log
 *   npm run tail:progress -- <path>    # tail a specific file
 *
 * Stops with Ctrl+C. Re-resolves the latest log file every 10s so it picks
 * up the next-day file after rollover.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

function logDir(): string {
  return process.env.LOG_DIR ?? './.logs';
}

function todaysLogPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(logDir(), 'app', `app-${today}.log`);
}

function latestLogPath(): string | null {
  const dir = path.join(logDir(), 'app');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((n) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(n))
    .sort();
  if (files.length === 0) return null;
  return path.join(dir, files[files.length - 1]!);
}

interface ForumStat {
  name: string;
  done: number;
  total: number;
  withPinned: number;
  withPlain: number;
  failed: number;
}

interface ProgressPayload {
  stage?: string;
  msg?: string;
  elapsed?: number;
  doneAll?: number;
  totalAll?: number;
  withPinnedAll?: number;
  withPlainAll?: number;
  failedAll?: number;
  orphans?: number;
  perForum?: Record<string, ForumStat>;
}

function tryParseProgress(line: string): ProgressPayload | null {
  if (!line.includes('"stage":"progress')) return null;
  try {
    return JSON.parse(line) as ProgressPayload;
  } catch {
    return null;
  }
}

function maxNameWidth(perForum: Record<string, ForumStat> | undefined): number {
  if (!perForum) return 0;
  let w = 0;
  for (const k of Object.keys(perForum)) {
    const n = perForum[k]!.name.length;
    if (n > w) w = n;
  }
  return w;
}

function visibleLength(s: string): number {
  // Strip simple ANSI escape sequences before measuring. Our format doesn't
  // include them but third-party stripping (PowerShell etc.) might.
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length;
}

function truncate(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

function formatBlock(p: ProgressPayload, termWidth: number): string[] {
  const ts = new Date().toLocaleTimeString();
  const tag = p.stage === 'progress.final' ? 'FINAL' : 'tick ';
  const total = p.totalAll ?? 0;
  const done = p.doneAll ?? 0;
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;

  const summary: string[] = [
    `[${ts}] ${tag}`,
    `进度 ${done}/${total} (${pct}%)`,
    `elapsed=${p.elapsed ?? 0}s`,
  ];
  if ((p.withPinnedAll ?? 0) > 0) summary.push(`pinned=${p.withPinnedAll}`);
  if ((p.withPlainAll ?? 0) > 0) summary.push(`plain=${p.withPlainAll}`);
  if ((p.failedAll ?? 0) > 0) summary.push(`failed=${p.failedAll}`);
  if ((p.orphans ?? 0) > 0) summary.push(`orphans=${p.orphans}`);

  const lines: string[] = [truncate(summary.join('  '), termWidth)];

  if (p.perForum) {
    const w = maxNameWidth(p.perForum);
    const keys = Object.keys(p.perForum).sort((a, b) => Number(a) - Number(b));
    for (const k of keys) {
      const f = p.perForum[k]!;
      const parts = [
        `  ${f.name.padEnd(w)}  ${String(f.done).padStart(3)}/${String(f.total).padEnd(3)}`,
      ];
      if (f.withPinned > 0) parts.push(`pin=${f.withPinned}`);
      if (f.withPlain > 0) parts.push(`plain=${f.withPlain}`);
      if (f.failed > 0) parts.push(`fail=${f.failed}`);
      lines.push(truncate(parts.join(' '), termWidth));
    }
  }
  return lines;
}

// In-place renderer for TTY. Tracks the previous block's line count so it
// can move the cursor up and clear before drawing the next block.
class InPlaceRenderer {
  private lastLineCount = 0;

  render(lines: string[]): void {
    const out = process.stdout;
    if (this.lastLineCount > 0) {
      out.write(`\x1b[${this.lastLineCount}A`); // up N lines
      out.write('\x1b[J');                       // clear from cursor to end of screen
    }
    out.write(lines.join('\n') + '\n');
    this.lastLineCount = lines.length;
  }

  /** Finalize: leave the last block on screen, drop a blank line after. */
  finalize(): void {
    if (this.lastLineCount > 0) process.stdout.write('\n');
    this.lastLineCount = 0;
  }
}

class LineModeRenderer {
  render(lines: string[]): void {
    for (const l of lines) process.stdout.write(l + '\n');
    process.stdout.write('\n');
  }
  finalize(): void { /* no-op */ }
}

async function tailFile(filePath: string, renderer: InPlaceRenderer | LineModeRenderer, controller: { stopped: boolean }, getTermWidth: () => number): Promise<void> {
  let position = 0;
  if (fs.existsSync(filePath)) {
    position = fs.statSync(filePath).size;
  }
  let buf = '';

  while (!controller.stopped) {
    if (!fs.existsSync(filePath)) {
      await sleep(500);
      continue;
    }
    const stat = fs.statSync(filePath);
    if (stat.size < position) {
      position = 0;
      buf = '';
    }
    if (stat.size > position) {
      const stream = fs.createReadStream(filePath, { start: position, end: stat.size - 1, encoding: 'utf-8' });
      for await (const chunk of stream) {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const payload = tryParseProgress(line);
          if (payload) {
            renderer.render(formatBlock(payload, getTermWidth()));
            if (payload.stage === 'progress.final') renderer.finalize();
          }
        }
      }
      position = stat.size;
    }
    await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const explicit = process.argv[2];
  const initial = explicit
    ? path.resolve(explicit)
    : (latestLogPath() ?? todaysLogPath());

  const isTty = !!process.stdout.isTTY;
  const renderer: InPlaceRenderer | LineModeRenderer = isTty
    ? new InPlaceRenderer()
    : new LineModeRenderer();
  const getTermWidth = (): number => isTty ? (process.stdout.columns ?? 120) : 200;

  console.log(`Tailing: ${initial}`);
  console.log(`Mode: ${isTty ? 'in-place (TTY)' : 'line (non-TTY fallback)'}. Ctrl+C to stop.\n`);

  const controller = { stopped: false };
  process.on('SIGINT', () => {
    controller.stopped = true;
    renderer.finalize();
    process.stdout.write('[stopped]\n');
    process.exit(0);
  });

  let current = initial;
  while (!controller.stopped) {
    const inner = { stopped: false };
    const tailPromise = tailFile(current, renderer, inner, getTermWidth);
    const rolloverWatch = (async () => {
      while (!controller.stopped && !inner.stopped) {
        await sleep(10000);
        if (explicit) continue;
        const latest = latestLogPath();
        if (latest && latest !== current) {
          renderer.finalize();
          process.stdout.write(`[rollover → ${latest}]\n`);
          current = latest;
          inner.stopped = true;
          return;
        }
      }
    })();
    await Promise.race([tailPromise, rolloverWatch]);
    inner.stopped = true;
    await tailPromise.catch(() => {});
  }
}

main().catch((err) => {
  console.error('tail-progress failed:', err);
  process.exit(1);
});
