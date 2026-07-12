import type { FeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { describe, expect, it } from "vitest";
import { FeedbackPublicationWorker } from "./feedback-publication-worker.js";
import { PostgresFeedbackPublicationWorkerStore } from "./feedback-publication-worker-store.js";
import type { FeedbackPublicationWorkerLease } from "./feedback-publication-worker-types.js";
import {
  GovernedGithubIssueAdapter,
  GithubIssueAdapterError,
  type GithubIssueProjection,
  type GithubIssueReconciliationResult,
} from "./github-issue-adapter.js";

const target: FeedbackPublicationTargetPolicySnapshotV1 = {
  apiOrigin: "https://api.github.com",
  repositoryId: "456",
  installationId: "123",
  owner: "owner",
  repository: "repository",
  labels: ["feedback"],
  targetKey: "public",
  labelPolicyVersion: "labels-v1",
  targetPolicyVersion: "target-v1",
};

function lease(
  mode: "create-eligible" | "reconcile-only" = "create-eligible",
): FeedbackPublicationWorkerLease {
  return {
    outboxId: "outbox",
    preparationId: "preparation",
    itemId: "item",
    title: "SENTINEL_TITLE",
    body: `SENTINEL_BODY <!-- keiko-feedback-reconciliation-v1:${"a".repeat(43)} -->`,
    projectionDigest: "b".repeat(64),
    reconciliationMarker: `<!-- keiko-feedback-reconciliation-v1:${"a".repeat(43)} -->`,
    target,
    targetPolicyDigest: "c".repeat(64),
    leaseOwner: "worker",
    leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
    mode,
    createAttemptCount: 0,
  } satisfies FeedbackPublicationWorkerLease;
}

const issue: GithubIssueProjection = {
  repositoryId: "456",
  number: 7,
  nodeId: "node",
  url: "https://github.com/owner/repository/issues/7",
  title: "SENTINEL_TITLE",
  body: "SENTINEL_BODY",
  labels: ["feedback"],
};

class FakeStore {
  readonly calls: string[] = [];
  readonly delays: number[] = [];
  readonly immediateOpens: boolean[] = [];
  candidate: FeedbackPublicationWorkerLease | undefined = lease();
  circuitFailures = 0;
  async withCandidate<T>(
    _options: unknown,
    handle: (value: FeedbackPublicationWorkerLease) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.candidate === undefined) return undefined;
    return handle(this.candidate);
  }
  recordSuccess(): Promise<void> {
    this.calls.push("success");
    this.circuitFailures = 0;
    return Promise.resolve();
  }
  enterProviderCircuit(): Promise<
    | { readonly allowed: true; readonly probe: boolean }
    | { readonly allowed: false; readonly delayMs: number }
  > {
    return Promise.resolve(
      this.circuitFailures >= 3
        ? { allowed: false, delayMs: 30_000 }
        : { allowed: true, probe: false },
    );
  }
  recordProviderFailure(_lease: unknown, delayMs: number, openImmediately = false): Promise<void> {
    this.circuitFailures = openImmediately ? 3 : this.circuitFailures + 1;
    this.delays.push(delayMs);
    this.immediateOpens.push(openImmediately);
    return Promise.resolve();
  }
  recordProviderProbeSuccess(): Promise<void> {
    this.calls.push("probe-healthy");
    this.circuitFailures = 0;
    return Promise.resolve();
  }
  scheduleRetry(_lease: unknown, _code: unknown, delayMs: number): Promise<"retryable-failure"> {
    this.calls.push("retry");
    this.delays.push(delayMs);
    return Promise.resolve("retryable-failure");
  }
  scheduleReconciliation(_lease: unknown, delayMs: number): Promise<void> {
    this.calls.push("reconcile-later");
    this.delays.push(delayMs);
    return Promise.resolve();
  }
  scheduleCircuitDeferral(_lease: unknown, delayMs: number): Promise<void> {
    this.calls.push("circuit-defer");
    this.delays.push(delayMs);
    return Promise.resolve();
  }
  recordManual(): Promise<void> {
    this.calls.push("manual");
    return Promise.resolve();
  }
}

class FakeAdapter {
  readonly calls: string[] = [];
  reconciliation: GithubIssueReconciliationResult = {
    kind: "not-observed",
    createAuthority: "requires-create-eligible-with-no-possibly-committed-post",
  };
  failure: GithubIssueAdapterError | undefined;
  createFailure: GithubIssueAdapterError | undefined;
  reconcileIssue(): Promise<GithubIssueReconciliationResult> {
    this.calls.push("reconcile");
    return this.failure === undefined
      ? Promise.resolve(this.reconciliation)
      : Promise.reject(this.failure);
  }
  publishClaimedCandidate(): Promise<GithubIssueProjection> {
    this.calls.push("create");
    return this.createFailure === undefined
      ? Promise.resolve(issue)
      : Promise.reject(this.createFailure);
  }
}

function worker(
  store: FakeStore,
  adapter: FakeAdapter,
  diagnostics: string[] = [],
): FeedbackPublicationWorker {
  return new FeedbackPublicationWorker({
    store: store as unknown as PostgresFeedbackPublicationWorkerStore,
    adapter: adapter as unknown as GovernedGithubIssueAdapter,
    workerId: "worker",
    leaseDurationMs: 60_000,
    circuitCooldownMs: 30_000,
    random: (): number => 0.5,
    diagnostics: (event): void => {
      diagnostics.push(JSON.stringify(event));
    },
  });
}

describe("feedback publication worker policy", () => {
  it("reconciles first and records an exact match without POST", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    adapter.reconciliation = { kind: "exact", issue };
    await worker(store, adapter).runOne();
    expect(adapter.calls).toEqual(["reconcile"]);
    expect(store.calls).toEqual(["success"]);
  });

  it("creates only for durable create eligibility after non-authoritative absence", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    await worker(store, adapter).runOne();
    expect(adapter.calls).toEqual(["reconcile", "create"]);
    expect(store.calls).toEqual(["success"]);

    store.calls.length = 0;
    adapter.calls.length = 0;
    store.candidate = lease("reconcile-only");
    await worker(store, adapter).runOne();
    expect(adapter.calls).toEqual(["reconcile"]);
    expect(store.calls).toEqual(["reconcile-later"]);
  });

  it("closes a half-open circuit after a complete not-observed reconciliation search", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    store.candidate = lease("reconcile-only");
    store.circuitFailures = 3;
    store.enterProviderCircuit = (): Promise<{ readonly allowed: true; readonly probe: true }> =>
      Promise.resolve({ allowed: true, probe: true });
    await worker(store, adapter).runOne();
    expect(adapter.calls).toEqual(["reconcile"]);
    expect(store.calls).toEqual(["probe-healthy", "reconcile-later"]);
    expect(store.circuitFailures).toBe(0);
  });

  it("reopens a half-open circuit when the probe is actually rate limited", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    store.candidate = lease("reconcile-only");
    store.enterProviderCircuit = (): Promise<{ readonly allowed: true; readonly probe: true }> =>
      Promise.resolve({ allowed: true, probe: true });
    adapter.failure = new GithubIssueAdapterError("rate-limited", "definite-pre-send", 600);
    await worker(store, adapter).runOne();
    expect(store.calls).toEqual(["reconcile-later"]);
    expect(store.immediateOpens).toEqual([true]);
    expect(store.circuitFailures).toBe(3);
  });

  it("retries definite pre-send transients, reconciles ambiguity, and settles permanent failures", async () => {
    const cases = [
      [new GithubIssueAdapterError("provider-unavailable", "definite-pre-send"), "retry"],
      [
        new GithubIssueAdapterError("provider-unavailable", "may-have-committed"),
        "reconcile-later",
      ],
      [new GithubIssueAdapterError("permission-denied", "definite-pre-send"), "manual"],
    ] as const;
    for (const [failure, expected] of cases) {
      const store = new FakeStore();
      const adapter = new FakeAdapter();
      adapter.failure = failure;
      await worker(store, adapter).runOne();
      expect(store.calls).toEqual([expected]);
    }
  });

  it("opens after three transient failures and emits content-free diagnostics", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const diagnostics: string[] = [];
    adapter.failure = new GithubIssueAdapterError("provider-unavailable", "definite-pre-send");
    const subject = worker(store, adapter, diagnostics);
    await subject.runOne();
    await subject.runOne();
    await subject.runOne();
    await subject.runOne();
    expect(adapter.calls).toHaveLength(3);
    expect(store.calls).toEqual(["retry", "retry", "retry", "circuit-defer"]);
    expect(diagnostics.join(" ")).not.toMatch(/SENTINEL|owner|repository|keiko-feedback/u);
  });

  it("propagates one provider delay to durable retry and circuit state", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    adapter.failure = new GithubIssueAdapterError("rate-limited", "definite-pre-send", 600);
    await worker(store, adapter).runOne();
    expect(store.calls).toEqual(["retry"]);
    expect(store.delays).toEqual([600_000, 600_000]);
    expect(store.immediateOpens).toEqual([true]);
  });

  it("does not reset failures after search success before three POST-only failures open", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    adapter.createFailure = new GithubIssueAdapterError(
      "provider-unavailable",
      "may-have-committed",
    );
    const subject = worker(store, adapter);
    await subject.runOne();
    await subject.runOne();
    await subject.runOne();
    await subject.runOne();
    expect(adapter.calls.filter((call) => call === "reconcile")).toHaveLength(3);
    expect(adapter.calls.filter((call) => call === "create")).toHaveLength(3);
    expect(store.calls.at(-1)).toBe("circuit-defer");
  });
});
