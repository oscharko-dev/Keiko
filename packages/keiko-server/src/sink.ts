// The QueueEventSink bridges the harness's push-only, synchronous EventSink (and the structurally
// identical workflow WorkflowEventSink / BugWorkflowEventSink) to Server-Sent Events (ADR-0011 D7).
// It satisfies all three sink shapes — each is `{ emit(event): void }` over an event that carries
// the `{ schemaVersion, runId, fingerprint, seq, ts, type }` envelope — with one `emit` typed over
// that structural envelope (no `any`; the concrete unions are assignable to it).
//
// It deliberately does NOT set `retainsRawContent`, so the harness emitter redacts every SENSITIVE
// field before this sink ever receives an event (the browser only sees redacted events). Internally
// it (a) appends each received event to a per-run BOUNDED ring buffer for replay-on-connect (oldest
// dropped past the cap), and (b) fans the event out to any currently-attached SSE writers. A late or
// reconnecting subscriber replays the buffer (respecting Last-Event-ID = the harness `seq`), then
// receives live events, then a close after the terminal event.

// The structural event envelope every harness/workflow event satisfies. Extra members vary per
// event type and are not accessed here (the sink only needs `seq` for replay and `type` for SSE
// framing); they ride along untyped-but-present in the serialized `data`.
export interface StreamEvent {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
}

// A single attached SSE consumer. `write` frames+sends one event; `close` ends the response.
export interface SseWriter {
  readonly write: (event: StreamEvent) => boolean | undefined;
  readonly close: () => void;
}

const DEFAULT_BUFFER_CAPACITY = 512;
// 1 MiB parity with CODING_RUNTIME_EVENT_HUB_MAX_BYTES. Small enough that one large
// patch:proposed diff cannot pin megabytes of buffered replay per active run, big
// enough that a normal SSE burst never trips it.
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

export interface QueueEventSinkOptions {
  // Max events retained for replay. Oldest are dropped once the cap is exceeded (bounded memory).
  readonly bufferCapacity?: number | undefined;
  // Max aggregate serialized bytes retained for replay. Oldest are dropped once exceeded.
  readonly maxBytes?: number | undefined;
}

interface BufferedEntry {
  readonly event: StreamEvent;
  readonly bytes: number;
}

const utf8Encoder = new TextEncoder();

function measureEventBytes(event: StreamEvent): number {
  return utf8Encoder.encode(JSON.stringify(event)).length;
}

export class QueueEventSink {
  // retainsRawContent is intentionally absent (never true): the harness must redact before emit.
  private readonly buffer: BufferedEntry[] = [];
  private bufferedBytes = 0;
  private readonly capacity: number;
  private readonly maxBytes: number;
  private readonly writers = new Set<SseWriter>();
  private terminated = false;

  // Bound so the sink can be passed directly as an `EventSink`/`WorkflowEventSink`/`BugWorkflowEventSink`.
  readonly emit = (event: StreamEvent): void => {
    const bytes = measureEventBytes(event);
    this.buffer.push({ event, bytes });
    this.bufferedBytes += bytes;
    while (this.buffer.length > this.capacity || this.bufferedBytes > this.maxBytes) {
      const dropped = this.buffer.shift();
      if (dropped === undefined) break;
      this.bufferedBytes -= dropped.bytes;
    }
    const failed: SseWriter[] = [];
    for (const writer of this.writers) {
      try {
        const accepted = writer.write(event);
        if (accepted === false) {
          failed.push(writer);
        }
      } catch {
        failed.push(writer);
      }
    }
    for (const writer of failed) {
      if (this.writers.delete(writer)) {
        writer.close();
      }
    }
  };

  constructor(options: QueueEventSinkOptions = {}) {
    this.capacity = options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    // Reject NaN / Infinity / negatives: any of the three silently disables the byte cap
    // and lets a run's replay grow without bound — the exact class KEIKO-0165 exists to
    // prevent. A caller passing a bogus option should fail loudly at construction.
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new RangeError("QueueEventSink maxBytes must be a finite, non-negative number");
    }
    this.maxBytes = maxBytes;
  }

  // Attaches an SSE writer: replays the buffered events with `seq` strictly greater than
  // `afterSeq` (Last-Event-ID resume), then keeps the writer attached for live fan-out. Returns a
  // detach function the caller invokes on client disconnect to stop fan-out and avoid leaks.
  attach(writer: SseWriter, afterSeq: number): () => void {
    for (const { event } of this.buffer) {
      if (event.seq > afterSeq) {
        const accepted = writer.write(event);
        if (accepted === false) {
          writer.close();
          return (): void => undefined;
        }
      }
    }
    this.writers.add(writer);
    return (): void => {
      this.writers.delete(writer);
    };
  }

  // Closes and clears every attached writer (called once the run terminates). The ring buffer is
  // retained for the registry TTL so a late subscriber can still replay history before eviction.
  closeAll(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    for (const writer of this.writers) {
      writer.close();
    }
    this.writers.clear();
  }

  isTerminated(): boolean {
    return this.terminated;
  }

  // Snapshot of buffered events with `seq` strictly greater than `afterSeq` (inspection/replay aid).
  buffered(afterSeq = -1): readonly StreamEvent[] {
    return this.buffer.filter(({ event }) => event.seq > afterSeq).map(({ event }) => event);
  }

  // Aggregate serialized-bytes retained across all buffered events. Exposed for tests and
  // observability; the sink evicts internally so callers do not have to poll this.
  bufferedByteSize(): number {
    return this.bufferedBytes;
  }
}
