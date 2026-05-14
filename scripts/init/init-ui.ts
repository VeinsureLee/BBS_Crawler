/**
 * Terminal UI for init-threads.
 *
 * - Default: in-place refreshing progress block (summary + per-forum lines).
 * - --verbose: same block + a scrolling event log above (board done / failed /
 *   skipped, retry pass markers, completion).
 *
 * The script silences pino's stdout sink (via LOG_STDOUT_DISABLED env var)
 * and renders here instead. File logs are untouched, so `tail:progress` in
 * another window keeps working.
 *
 * Non-TTY (output piped) auto-falls back to plain line-mode (no cursor
 * tricks): events print as they arrive, progress prints periodically.
 */

export interface ForumLine {
  name: string;
  done: number;
  total: number;
  withPinned: number;
  withPlain: number;
  failed: number;
}

export interface ProgressSnapshot {
  elapsed: number;
  doneAll: number;
  totalAll: number;
  withPinnedAll: number;
  withPlainAll: number;
  failedAll: number;
  orphans: number;
  perForum: ForumLine[];
}

export interface UiOptions {
  verbose: boolean;
  /** Show plain/pinned columns? When false, pinned-only run hides the plain column. */
  showPlain: boolean;
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length;
}

function truncate(s: string, width: number): string {
  const len = visibleLen(s);
  if (len <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

function pad(n: number, width: number): string {
  return String(n).padStart(width);
}

function fmtElapsed(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export class Ui {
  private readonly verbose: boolean;
  private readonly showPlain: boolean;
  private readonly isTty: boolean;
  private readonly events: string[] = [];
  private snapshot: ProgressSnapshot | null = null;
  private renderTimer: NodeJS.Timeout | null = null;
  private lastBlockHeight = 0;
  private bannerPrinted = false;
  private stopped = false;
  private getSnapshot: (() => ProgressSnapshot) | null = null;

  constructor(opts: UiOptions) {
    this.verbose = opts.verbose;
    this.showPlain = opts.showPlain;
    this.isTty = !!process.stdout.isTTY;
  }

  banner(line: string): void {
    if (this.bannerPrinted) return;
    process.stdout.write(line + '\n');
    process.stdout.write('\n');
    this.bannerPrinted = true;
  }

  start(getSnapshot: () => ProgressSnapshot, intervalMs = 500): void {
    if (this.renderTimer) return;
    this.getSnapshot = getSnapshot;
    this.renderTimer = setInterval(() => this.tick(), intervalMs);
    if (this.renderTimer.unref) this.renderTimer.unref();
  }

  /** Verbose-only event (board done / failed / skipped). */
  event(msg: string): void {
    if (!this.verbose) return;
    this.events.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  }

  /** Always-shown event (retry-pass markers, completion notes). */
  note(msg: string): void {
    this.events.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  }

  stop(finalNote?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    // Force one final render so the latest snapshot and any queued events
    // make it to the terminal.
    this.tick();
    if (finalNote) {
      // After tick(), the cursor is right after the progress block. Print the
      // final note as a normal scroll line below it.
      process.stdout.write('\n' + finalNote + '\n');
      this.lastBlockHeight = 0;
    }
  }

  private tick(): void {
    if (this.getSnapshot) this.snapshot = this.getSnapshot();

    if (!this.isTty) {
      // Line mode: drain events as standalone lines, optionally a progress
      // snapshot too. We only print the snapshot if there are queued events
      // OR every Nth tick to avoid drowning log captures.
      if (this.events.length > 0) {
        for (const e of this.events) process.stdout.write(e + '\n');
        this.events.length = 0;
      }
      // In non-TTY mode the snapshot is too noisy to print every 500ms;
      // skip it unless final.
      return;
    }

    // TTY in-place mode.
    const width = process.stdout.columns ?? 120;
    const newLines: string[] = this.snapshot ? this.formatBlock(this.snapshot, width) : [];

    // Wipe the previous progress block.
    if (this.lastBlockHeight > 0) {
      process.stdout.write(`\x1b[${this.lastBlockHeight}A\x1b[J`);
    }

    // Drain queued events into the scroll history (above the new block).
    if (this.events.length > 0) {
      for (const e of this.events) {
        process.stdout.write(truncate(e, width) + '\n');
      }
      this.events.length = 0;
    }

    // Draw the new block.
    if (newLines.length > 0) {
      process.stdout.write(newLines.join('\n') + '\n');
    }
    this.lastBlockHeight = newLines.length;
  }

  private formatBlock(s: ProgressSnapshot, width: number): string[] {
    const lines: string[] = [];
    const pct = s.totalAll > 0 ? Math.floor((s.doneAll / s.totalAll) * 100) : 0;

    const bar = this.renderBar(s.doneAll, s.totalAll, 24);
    const header = [
      bar,
      `${pad(s.doneAll, 3)}/${pad(s.totalAll, 3)}`,
      `(${pad(pct, 3)}%)`,
      fmtElapsed(s.elapsed),
    ];
    const tail: string[] = [];
    if (s.withPinnedAll > 0) tail.push(`置顶=${s.withPinnedAll}`);
    if (s.withPlainAll > 0 && this.showPlain) tail.push(`普通=${s.withPlainAll}`);
    if (s.failedAll > 0) tail.push(`失败=${s.failedAll}`);
    if (s.orphans > 0) tail.push(`孤儿=${s.orphans}`);
    lines.push(truncate(header.join('  ') + (tail.length > 0 ? '   ' + tail.join('  ') : ''), width));

    // Per-forum table.
    if (s.perForum.length > 0) {
      lines.push(''); // visual separator
      const nameW = Math.max(...s.perForum.map((f) => visibleLen(f.name)));
      const totalW = String(Math.max(...s.perForum.map((f) => f.total))).length;
      for (const f of s.perForum) {
        const segs = [
          '  ' + f.name.padEnd(nameW),
          `${pad(f.done, totalW)}/${String(f.total).padEnd(totalW)}`,
        ];
        if (f.withPinned > 0) segs.push(`pin=${pad(f.withPinned, 2)}`);
        if (f.withPlain > 0 && this.showPlain) segs.push(`plain=${pad(f.withPlain, 2)}`);
        if (f.failed > 0) segs.push(`fail=${f.failed}`);
        lines.push(truncate(segs.join('  '), width));
      }
    }
    return lines;
  }

  private renderBar(done: number, total: number, width: number): string {
    if (total <= 0) return '[' + ' '.repeat(width) + ']';
    const filled = Math.min(width, Math.round((done / total) * width));
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
  }
}
