import { randomUUID } from "node:crypto";
import { FeedbackPublicationRunner } from "./feedback-publication-runner.js";
import {
  type FeedbackPublicationDiagnostic,
  FeedbackPublicationWorker,
} from "./feedback-publication-worker.js";
import { PostgresFeedbackPublicationWorkerStore } from "./feedback-publication-worker-store.js";
import { GithubAppPrivateKeyProvider } from "./github-app-key.js";
import { FixedOriginGithubTransport } from "./github-app-transport.js";
import { GovernedGithubIssueAdapter } from "./github-issue-adapter.js";
import type { GithubPublicationRuntimeConfig } from "./runtime-config.js";
import type { RuntimePool } from "./runtime-pools.js";
import type { RuntimeTimer } from "./runtime-timer.js";

export interface FeedbackPublicationRuntimeOptions {
  readonly config: Extract<GithubPublicationRuntimeConfig, { readonly enabled: true }>;
  readonly primaryPool: RuntimePool;
  readonly sessionPool: RuntimePool;
  readonly timer: RuntimeTimer;
  readonly drainDeadlineMs: number;
  readonly now: () => Date;
  readonly diagnostics?: ((event: FeedbackPublicationDiagnostic) => void) | undefined;
  readonly onHealthChange?: ((healthy: boolean) => void) | undefined;
}

export class FeedbackPublicationRuntime {
  private readonly adapter: GovernedGithubIssueAdapter;
  private readonly runner: FeedbackPublicationRunner;

  constructor(options: FeedbackPublicationRuntimeOptions) {
    const keyProvider = new GithubAppPrivateKeyProvider(
      options.config.github.privateKeyFile,
      new Date(options.config.github.privateKeyRotatedAt),
    );
    this.adapter = new GovernedGithubIssueAdapter({
      config: options.config.github,
      keyProvider,
      transport: new FixedOriginGithubTransport(),
      trustedNow: options.now,
    });
    const store = new PostgresFeedbackPublicationWorkerStore(
      options.primaryPool,
      options.sessionPool,
      (key) => options.config.github.targets.get(key)?.snapshot,
    );
    const worker = new FeedbackPublicationWorker({
      store,
      adapter: this.adapter,
      workerId: `publication:${randomUUID()}`,
      leaseDurationMs: options.config.leaseDurationMs,
      circuitCooldownMs: options.config.circuitCooldownMs,
      diagnostics: options.diagnostics ?? defaultPublicationDiagnostics,
    });
    this.runner = new FeedbackPublicationRunner({
      worker,
      concurrency: options.config.maxConcurrentDeliveries,
      pollIntervalMs: options.config.pollIntervalMs,
      drainDeadlineMs: options.drainDeadlineMs,
      timer: options.timer,
      diagnostics: options.diagnostics ?? defaultPublicationDiagnostics,
      onHealthChange: options.onHealthChange,
    });
  }

  inspectReadiness(): Promise<void> {
    return this.adapter.inspectReadiness();
  }

  start(): void {
    this.runner.start();
  }

  stop(deadlineAt?: number): Promise<void> {
    return this.runner.stop(deadlineAt);
  }
}

function defaultPublicationDiagnostics(event: FeedbackPublicationDiagnostic): void {
  process.stderr.write(
    `${JSON.stringify({
      event: "feedback-publication",
      category: event.category,
      code: event.code,
      count: event.count,
      durationMs: event.durationMs,
    })}\n`,
  );
}
