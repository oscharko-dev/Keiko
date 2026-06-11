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

export interface QueueEventSinkOptions {
  // Max events retained for replay. Oldest are dropped once the cap is exceeded (bounded memory).
  readonly bufferCapacity?: number | undefined;
}

export class QueueEventSink {
  // retainsRawContent is intentionally absent (never true): the harness must redact before emit.
  private readonly buffer: StreamEvent[] = [];
  private readonly capacity: number;
  private readonly writers = new Set<SseWriter>();
  private terminated = false;
  private nextSeq = 0;

  // Bound so the sink can be passed directly as an `EventSink`/`WorkflowEventSink`/`BugWorkflowEventSink`.
  readonly emit = (event: StreamEvent): void => {
    const sequenced = { ...event, seq: this.nextSeq++ } satisfies StreamEvent;
    this.buffer.push(sequenced);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    for (const writer of [...this.writers]) {
      try {
        const accepted = writer.write(sequenced);
        if (accepted === false) {
          this.writers.delete(writer);
          writer.close();
        }
      } catch {
        this.writers.delete(writer);
        writer.close();
      }
    }
  };

  constructor(options: QueueEventSinkOptions = {}) {
    this.capacity = options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
  }

  // Attaches an SSE writer: replays the buffered events with `seq` strictly greater than
  // `afterSeq` (Last-Event-ID resume), then keeps the writer attached for live fan-out. Returns a
  // detach function the caller invokes on client disconnect to stop fan-out and avoid leaks.
  attach(writer: SseWriter, afterSeq: number): () => void {
    for (const event of this.buffer) {
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
    return this.buffer.filter((event) => event.seq > afterSeq);
  }
}
