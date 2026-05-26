// Shared "backlog + tail until terminal" SSE driver. Replays stored run_events
// for an analysis (from a given seq) and, while the run is still in flight, polls
// for new events and emits them live until a terminal event (`report`/`error`) is
// emitted or the analysis status itself goes terminal. Used by both the
// reconnect/tail endpoint (GET /api/analyze/:id/events) and the in-flight
// same-commit attach path in POST /api/analyze, so a late or reconnecting client
// sees exactly the same SSE bytes the original run streamed.

import { getAnalysis, getEvents, type AnalysisStatus, type RunEvent } from '../db/analyses';
import type { Client } from '@libsql/client';

type Conn = Pick<Client, 'execute'>;

// Event types that end a run. Once one is emitted, the stream is complete.
const TERMINAL_EVENT_TYPES = new Set(['report', 'error']);

function isTerminalStatus(status: AnalysisStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

export type ReplayDeps = {
  db?: Conn;
  /** Poll interval while tailing (ms). Default ~1s. */
  pollIntervalMs?: number;
  /** Hard wall-clock bound for the whole tail (ms). Defaults below maxDuration. */
  deadlineMs?: number;
  /** Injectable sleep + clock so tests run without real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_POLL_MS = 1000;
// Stay comfortably under the route's maxDuration (300s) so the stream closes
// itself before the platform kills the function mid-write.
const DEFAULT_DEADLINE_MS = 290_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drive the backlog + tail loop, invoking `emit(event)` for each run_event in seq
 * order (starting after `afterSeq`). Resolves once a terminal event is emitted,
 * the analysis status goes terminal (with no further events to drain), or the
 * deadline is hit. Never throws on a "still running" analysis — it's the caller's
 * job to have 404'd an unknown id before calling this.
 *
 * Returns the last seq emitted, so a caller can report progress.
 */
export async function replayAndTail(
  analysisId: string,
  afterSeq: number,
  emit: (event: RunEvent) => void | Promise<void>,
  deps: ReplayDeps = {}
): Promise<number> {
  const client = deps.db;
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  const start = now();
  let lastSeq = afterSeq;
  let sawTerminalEvent = false;

  // Drain every new event since lastSeq; flips sawTerminalEvent on report/error.
  const drain = async (): Promise<void> => {
    const events = await getEvents(analysisId, lastSeq, client);
    for (const ev of events) {
      await emit(ev);
      lastSeq = ev.seq;
      if (TERMINAL_EVENT_TYPES.has(ev.type)) sawTerminalEvent = true;
    }
  };

  // 1) Backlog.
  await drain();
  if (sawTerminalEvent) return lastSeq;

  // 2) Tail. Stop when a terminal event arrives, the analysis status goes
  //    terminal (and we've drained any trailing events), or we hit the deadline.
  for (;;) {
    const analysis = await getAnalysis(analysisId, client);
    // A vanished row (shouldn't happen mid-run) ends the tail rather than spin.
    if (!analysis) return lastSeq;

    if (isTerminalStatus(analysis.status)) {
      // Status flipped terminal — drain any final events the run wrote, then stop.
      await drain();
      return lastSeq;
    }

    if (now() - start >= deadlineMs) return lastSeq;

    await sleep(pollMs);
    await drain();
    if (sawTerminalEvent) return lastSeq;
  }
}

/**
 * Build a text/event-stream ReadableStream that replays + tails an analysis,
 * formatting each run_event as `event: <type>\ndata: <data>\n\n` — byte-for-byte
 * the shape POST /api/analyze emits and the client already parses.
 */
export function analysisEventStream(
  analysisId: string,
  afterSeq: number,
  deps: ReplayDeps & {
    /** Emit a leading `event: id` control frame so an attaching client learns the
     * analysis id and can itself reconnect if this stream later drops. */
    emitIdEvent?: boolean;
  } = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (deps.emitIdEvent) {
        controller.enqueue(encoder.encode(`event: id\ndata: ${JSON.stringify({ analysisId })}\n\n`));
      }
      const emit = (event: RunEvent) => {
        // run_events store the raw event payload under `data`; emit it as-is so
        // the wire format matches the live POST stream exactly. The `id:` line
        // carries the run_events seq — the client's reconnect cursor (afterSeq).
        controller.enqueue(
          encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
        );
      };
      try {
        await replayAndTail(analysisId, afterSeq, emit, deps);
      } catch {
        // Never leak internals onto a public read-only stream. Close quietly; the
        // client treats a non-terminal close as "reconnect", which is the right
        // recovery for a transient DB blip here too.
      } finally {
        controller.close();
      }
    },
  });
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export function sseHeaders(): Record<string, string> {
  return { ...SSE_HEADERS };
}
