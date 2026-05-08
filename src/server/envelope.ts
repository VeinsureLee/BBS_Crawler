/**
 * Uniform tool response envelope.
 *
 * Success: { ok: true, data, [nextCursor], [state] }
 * Failure: { ok: false, error: { code, message } }
 *
 * All four MCP tools wrap their bodies through `wrap()` so the agent sees a
 * consistent shape. The MCP SDK requires content be a text part — we serialize
 * the envelope as JSON and return it as a single text part.
 */
import { toToolError } from './error-codes';

export interface SuccessPayload {
  data: unknown;
  /** null = no more pages; undefined = field omitted entirely. */
  nextCursor?: unknown;
  /** Used by forum_list_threads to surface per-board crawl state. */
  state?: unknown;
}

export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  /** MCP SDK's CallToolResult allows arbitrary extension fields. */
  [k: string]: unknown;
}

export async function wrap(fn: () => Promise<SuccessPayload>): Promise<ToolResponse> {
  try {
    const out = await fn();
    const body: Record<string, unknown> = { ok: true, data: out.data };
    if (out.nextCursor !== undefined) body.nextCursor = out.nextCursor;
    if (out.state !== undefined) body.state = out.state;
    return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
  } catch (e) {
    const err = toToolError(e);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          error: { code: err.code, message: err.message },
        }),
      }],
    };
  }
}
