import {
  FeedbackPublicationWorker,
  type FeedbackPublicationDiagnostic,
} from "./feedback-publication-worker.js";
import type { RuntimeTimer } from "./runtime-timer.js";

const INTERNAL_FAILURE_THRESHOLD = 3;

export interface FeedbackPublicationRunnerOptions {
  readonly worker: FeedbackPublicationWorker;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly maxIdleIntervalMs?: number | undefined;
  readonly drainDeadlineMs: number;
  readonly timer: RuntimeTimer;
  readonly diagnostics?: ((event: FeedbackPublicationDiagnostic) => void) | undefined;
  readonly onHealthChange?: ((healthy: boolean) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

export class FeedbackPublicationRunner {
  private readonly abort = new AbortController();
  private readonly active = new Set<Promise<boolean>>();
  private readonly now: () => number;
  private handle: unknown;
  private stopping = false;
  private idleIntervalMs: number;
  private internalFailures = 0;

  constructor(private readonly options: FeedbackPublicationRunnerOptions) {
    this.idleIntervalMs = options.pollIntervalMs;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.handle !== undefined || this.stopping || this.active.size > 0) return;
    this.launch();
  }

  private launch(): void {
    if (this.stopping || this.active.size >= this.options.concurrency) return;
    const startedAt = this.now();
    const task = this.options.worker.runOne(this.abort.signal);
    this.active.add(task);
    void task.then(
      (found) => {
        this.complete(task, found);
      },
      () => {
        this.failed(task, startedAt);
      },
    );
  }

  private complete(task: Promise<boolean>, found: boolean): void {
    this.active.delete(task);
    if (this.stopping) return;
    this.internalFailures = 0;
    this.options.onHealthChange?.(true);
    if (found) {
      this.idleIntervalMs = this.options.pollIntervalMs;
      while (this.active.size < this.options.concurrency) this.launch();
      return;
    }
    if (this.active.size === 0) this.scheduleIdleProbe();
  }

  private failed(task: Promise<boolean>, startedAt: number): void {
    this.active.delete(task);
    this.internalFailures += 1;
    this.options.diagnostics?.({
      category: "worker",
      code: "internal-failure",
      count: this.internalFailures,
      durationMs: Math.max(0, this.now() - startedAt),
    });
    if (this.internalFailures >= INTERNAL_FAILURE_THRESHOLD) {
      this.options.onHealthChange?.(false);
    }
    if (!this.stopping && this.active.size === 0) this.scheduleIdleProbe();
  }

  private scheduleIdleProbe(): void {
    const maximum = this.options.maxIdleIntervalMs ?? 30_000;
    const delay = this.idleIntervalMs;
    this.idleIntervalMs = Math.min(maximum, Math.max(this.options.pollIntervalMs, delay * 2));
    if (this.handle !== undefined) this.options.timer.clearInterval(this.handle);
    this.handle = this.options.timer.setInterval(() => {
      const handle = this.handle;
      this.handle = undefined;
      if (handle !== undefined) this.options.timer.clearInterval(handle);
      this.launch();
    }, delay);
  }

  async stop(deadlineAt = this.now() + this.options.drainDeadlineMs): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.handle !== undefined) this.options.timer.clearInterval(this.handle);
    this.abort.abort();
    const remainingMs = Math.max(0, deadlineAt - this.now());
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, remainingMs);
      timeout.unref();
    });
    try {
      await Promise.race([Promise.allSettled([...this.active]).then(() => undefined), deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
