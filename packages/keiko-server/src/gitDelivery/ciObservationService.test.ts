import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCodingRuntimeCiResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-ci";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import type {
  GitCiFactsResult,
  GitCiProviderFacts,
  GitCiProviderReader,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { createCodingRuntimeCiReadinessStore } from "../coding-runtime/codingRuntimeCiReadinessStore.js";
import { createCodingRuntimeCiRepairBudgetStore } from "../coding-runtime/codingRuntimeCiRepairBudgetStore.js";
import { CodingRuntimeCiRepairController } from "../coding-runtime/codingRuntimeCiRepairController.js";
import type { CiRepairBudgetContext } from "../coding-runtime/codingRuntimeCiRepairBudgetTypes.js";
import { redactLogFields } from "../observability/log-redaction.js";
import { DraftDeliveryFixture } from "./draftDeliveryServiceTestSupport.js";
import { CiObservationController, type CiObservationOptions } from "./ciObservationService.js";
import { CHECK, failureFacts } from "./ciObservationTest/_providerFacts.js";
import type { GitCiFailureContextResult } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";

let fixture: DraftDeliveryFixture;
beforeEach(async () => {
  fixture = new DraftDeliveryFixture();
  await fixture.recordVerifiedCommit();
  await deliver(await fixture.service.proposePush());
  await deliver(await fixture.service.proposePullRequest("feat: accepted issue"));
});
afterEach(() => {
  fixture.close();
});
async function deliver(result: CodingRuntimeDeliveryResult): Promise<void> {
  if (result.status !== "recorded") throw new Error("Missing draft proposal");
  fixture.service.issueApproval(result.record.proposalId);
  const lease = fixture.service.consumeApproval(result.record.proposalId);
  if (lease === undefined) throw new Error("Missing test approval");
  expect(
    await fixture.service.executeApproved(result.record.proposalId, lease, { check: () => true }),
  ).toMatchObject({ status: "recorded" });
}
function facts(): GitCiProviderFacts {
  const identity = fixture.prs[0];
  if (identity === undefined) throw new Error("Missing confirmed fixture PR");
  const page = {
    values: [],
    completeness: { complete: true, pages: 1, entries: 0, bytes: 2 },
  } as const;
  return {
    status: "observed",
    identity,
    repositoryId: 41,
    mergeable: true,
    mergeState: "clean",
    merged: false,
    protection: { outcome: "unprotected" },
    requirements: { status: "observed", requirements: [], strict: false, digest: "a".repeat(64) },
    workflowDefinitions: { status: "observed", definitions: [] },
    lists: {
      "branch-rules": page,
      "check-runs": page,
      "commit-statuses": page,
      "workflow-runs": page,
      reviews: page,
    },
  };
}
function configured(read = (): Promise<GitCiFactsResult> => Promise.resolve(facts())): {
  readonly service: CiObservationController;
  readonly options: CiObservationOptions;
  readonly readFacts: ReturnType<typeof vi.fn<typeof read>>;
  readonly changed: ReturnType<typeof vi.fn>;
} {
  const readFacts = vi.fn(read);
  const changed = vi.fn();
  const options: CiObservationOptions = {
    ...fixture.options,
    persistence: createCodingRuntimeCiReadinessStore(fixture.db, fixture.snapshots),
    onChanged: changed,
    ciReader: (): GitCiProviderReader => ({ readFacts }),
  };
  return { service: new CiObservationController(options), options, readFacts, changed };
}
function failedFacts(): GitCiProviderFacts {
  const base = facts();
  const source = failureFacts([{ ...CHECK, headSha: base.identity.headSha }]);
  return { ...source, identity: base.identity };
}
function diagnostics(source = failedFacts()): GitCiFailureContextResult {
  return {
    status: "observed",
    context: {
      schemaVersion: "1",
      trust: "untrusted-provider-content",
      usage: "diagnostic-data-only",
      repository: source.identity.repository,
      prNumber: source.identity.number,
      headSha: source.identity.headSha,
      baseSha: source.identity.baseSha,
      sourceCount: 1,
      entries: [
        {
          kind: "check-summary",
          sourceKind: "check-run",
          sourceId: CHECK.id,
          title: "Compiler diagnostic",
          text: "Transient error details.",
        },
      ],
      completeness: { complete: true, entries: 1, pages: 5, bytes: 200 },
    },
  };
}
describe("run-bound CI observations through existing draft authority", () => {
  it("supersedes all CI facts when the diagnostic owner observes a provider revision change", async () => {
    const test = configured(() => Promise.resolve(failedFacts()));
    const service = new CiObservationController({
      ...test.options,
      ciReader: (): GitCiProviderReader => ({
        readFacts: test.readFacts,
        readFailureContext: (): Promise<GitCiFailureContextResult> =>
          Promise.resolve({
            status: "unavailable",
            failure: { reason: "revision-changed", state: "pending" },
          }),
      }),
    });
    expect(await service.observe()).toMatchObject({
      status: "unavailable",
      reason: "observation-superseded",
    });
    expect(test.options.persistence.get("run-1")).toBeUndefined();
    expect(test.changed).not.toHaveBeenCalled();
  });
  it("returns bounded failed-source details to the tool without persisting or logging their content", async () => {
    const source = failedFacts();
    const test = configured(() => Promise.resolve(source));
    const readFailureContext = vi.fn(() => Promise.resolve(diagnostics(source)));
    const service = new CiObservationController({
      ...test.options,
      ciReader: (): GitCiProviderReader => ({ readFacts: test.readFacts, readFailureContext }),
    });
    const result = await service.observe();
    expect(isCodingRuntimeCiResult(result)).toBe(true);
    expect(result).toMatchObject({
      status: "observed",
      snapshot: { state: "failed" },
      failureContext: diagnostics(source),
    });
    expect(readFailureContext).toHaveBeenCalledWith(source);
    expect(JSON.stringify(test.options.persistence.get("run-1"))).not.toContain(
      "Transient error details.",
    );
    expect(JSON.stringify(test.changed.mock.calls)).not.toContain("Transient error details.");
    expect(JSON.stringify(fixture.events)).not.toContain("Transient error details.");
    const line = fixture.events.filter((event) => event.op === "git.ci-observation").at(-1);
    expect(redactLogFields(line?.extra ?? {})).toMatchObject({
      sourceCount: 1,
      entryCount: 1,
      contextComplete: true,
    });
  });
  it("quarantines diagnostics that arrive after the authority is revoked", async () => {
    const test = configured(() => Promise.resolve(failedFacts()));
    const service = new CiObservationController({
      ...test.options,
      ciReader: (): GitCiProviderReader => ({
        readFacts: test.readFacts,
        readFailureContext: (): Promise<GitCiFailureContextResult> => {
          fixture.live = false;
          return Promise.resolve(diagnostics());
        },
      }),
    });
    expect(await service.observe()).toMatchObject({
      status: "unavailable",
      reason: "authority-denied",
    });
    expect(test.options.persistence.get("run-1")).toBeUndefined();
    expect(test.changed).not.toHaveBeenCalled();
  });
  it("keeps failure evidence when its diagnostic reader is unavailable", async () => {
    const test = configured(() => Promise.resolve(failedFacts()));
    expect(await test.service.observe()).toMatchObject({
      status: "observed",
      snapshot: { state: "failed" },
      failureContext: { status: "unavailable", failure: { reason: "visibility-unknown" } },
    });
  });
  it("rejects diagnostic content bound to another revision while retaining failed readiness", async () => {
    const test = configured(() => Promise.resolve(failedFacts()));
    const foreign = diagnostics({
      ...failedFacts(),
      identity: { ...facts().identity, headSha: "c".repeat(40) },
    });
    const service = new CiObservationController({
      ...test.options,
      ciReader: (): GitCiProviderReader => ({
        readFacts: test.readFacts,
        readFailureContext: (): Promise<GitCiFailureContextResult> => Promise.resolve(foreign),
      }),
    });
    expect(await service.observe()).toMatchObject({
      status: "observed",
      snapshot: { state: "failed" },
      failureContext: { status: "unavailable", failure: { reason: "revision-changed" } },
    });
  });
  it("records fresh body-free evidence only for the confirmed PR and emits its runtime change", async () => {
    const test = configured();
    const result = await test.service.observe();
    expect(isCodingRuntimeCiResult(result)).toBe(true);
    expect(result).toMatchObject({
      status: "observed",
      snapshot: { state: "technical-ready", headSha: fixture.prs[0]?.headSha },
    });
    expect(test.readFacts).toHaveBeenCalledWith({
      ownerAndRepo: "owner/repository",
      prExternalId: "17",
      baseBranchName: "master",
      headSha: fixture.prs[0]?.headSha,
    });
    expect(test.changed).toHaveBeenCalledOnce();
    expect(test.options.persistence.get("run-1")).toEqual(test.changed.mock.calls[0]?.[0]);
    expect(fixture.pushCount).toBe(1);
    expect(fixture.createCount).toBe(1);
    const lines = fixture.events.filter((event) => event.op === "git.ci-observation");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.correlationId === fixture.context.correlationId)).toBe(true);
    expect(redactLogFields(lines.at(-1)?.extra ?? {})).toMatchObject({
      phase: "observed",
      state: "technical-ready",
      complete: true,
      requiredCount: 0,
    });
  });
  it("does not read provider data after a live authority revocation", async () => {
    const test = configured();
    fixture.live = false;
    expect(await test.service.observe()).toMatchObject({
      status: "unavailable",
      reason: "authority-denied",
    });
    expect(test.readFacts).not.toHaveBeenCalled();
  });
  it("discards a response that arrives after authority revocation", async () => {
    const test = configured(() => {
      fixture.live = false;
      return Promise.resolve(facts());
    });
    expect(await test.service.observe()).toMatchObject({
      status: "unavailable",
      reason: "authority-denied",
    });
    expect(test.changed).not.toHaveBeenCalled();
    expect(test.options.persistence.get("run-1")).toBeUndefined();
  });
  it("reports authority denial when target resolution observes revocation", async () => {
    const test = configured();
    const service = new CiObservationController({
      ...test.options,
      resolveTarget: async (context): ReturnType<CiObservationOptions["resolveTarget"]> => {
        const target = await fixture.options.resolveTarget(context);
        fixture.live = false;
        return target;
      },
    });
    expect(await service.observe()).toMatchObject({ reason: "authority-denied" });
    expect(test.readFacts).not.toHaveBeenCalled();
  });
  it("rejects a clock that becomes invalid while observing", async () => {
    const test = configured(() => {
      fixture.now = Number.NaN;
      return Promise.resolve(facts());
    });
    expect(await test.service.observe()).toMatchObject({ status: "unavailable" });
    expect(test.changed).not.toHaveBeenCalled();
  });
  it("enforces persisted polling backoff after controller reconstruction without charging repair attempts", async () => {
    const test = configured();
    await test.service.observe();
    const restarted = new CiObservationController(test.options);
    expect(await restarted.observe()).toMatchObject({
      status: "unavailable",
      reason: "poll-backoff",
      retryAfterMs: 5_000,
    });
    expect(test.readFacts).toHaveBeenCalledOnce();
    expect(
      fixture.db.prepare("SELECT count(*) AS count FROM coding_runtime_ci_repair_budgets").get()
        ?.count,
    ).toBe(0);
    fixture.now += 5_000;
    expect(await restarted.observe()).toMatchObject({ status: "observed" });
    expect(test.readFacts).toHaveBeenCalledTimes(2);
  });
  it("allows an internal final freshness check but grants no merge operation", async () => {
    const test = configured();
    await test.service.observe();
    expect(await test.service.observe(true)).toMatchObject({ status: "observed" });
    expect(test.readFacts).toHaveBeenCalledTimes(2);
    expect(fixture.pushCount).toBe(1);
    expect(fixture.createCount).toBe(1);
  });
  it("keeps throttled observations pending with a bounded retry interval", async () => {
    const test = configured(() =>
      Promise.resolve({
        status: "unavailable",
        failure: { state: "pending", reason: "rate-limited" },
      }),
    );
    expect(await test.service.observe()).toMatchObject({
      status: "observed",
      retryAfterMs: 30_000,
      snapshot: { state: "pending", complete: false },
    });
    expect(await test.service.observe()).toMatchObject({
      reason: "poll-backoff",
      retryAfterMs: 30_000,
    });
  });
  it("keeps concurrent requests and older completion from replacing newer evidence", async () => {
    let release: ((value: GitCiFactsResult) => void) | undefined;
    const pending = new Promise<GitCiFactsResult>((resolve) => {
      release = resolve;
    });
    const test = configured(() => pending);
    const running = test.service.observe();
    await vi.waitFor(() => {
      expect(test.readFacts).toHaveBeenCalledOnce();
    });
    expect(await test.service.observe()).toMatchObject({ reason: "observation-in-flight" });
    test.options.persistence.begin("run-1");
    release?.(facts());
    expect(await running).toMatchObject({ reason: "observation-superseded" });
    expect(test.changed).not.toHaveBeenCalled();
  });
  it("preserves a structured diagnostic without including the thrown provider message", async () => {
    const test = configured(() => Promise.reject(new Error("raw provider secret payload")));
    expect(await test.service.observe()).toMatchObject({ reason: "provider-unavailable" });
    const line = fixture.events.filter((event) => event.op === "git.ci-observation").at(-1);
    expect(line).toMatchObject({
      errorKind: "internal",
      correlationId: fixture.context.correlationId,
    });
    expect(JSON.stringify(line)).not.toContain("raw provider secret payload");
  });
  // #3384 B5-1: threads the CI repair budget owner's raw exhaustion fact into the emitted
  // readiness reason, through the real production classes rather than a stub -- an actual
  // `CodingRuntimeCiRepairController` backed by a real `CodingRuntimeCiRepairBudgetStore` on the
  // same run, still failing required checks, whose ledger has spent its (tiny, test-only) deadline.
  it("surfaces the repair budget's exhaustion as the readiness reason through the production controller", async () => {
    const test = configured(() => Promise.resolve(failedFacts()));
    const draft = fixture.snapshots.get("run-1")?.draftDelivery;
    const prNumber = draft?.pullRequest?.number;
    if (draft === undefined || prNumber === undefined) throw new Error("Missing fixture draft");
    const budgetStore = createCodingRuntimeCiRepairBudgetStore({
      db: fixture.db,
      snapshots: fixture.snapshots,
      activityLog: { write: () => undefined },
      now: () => fixture.now,
    });
    const repairContext: CiRepairBudgetContext = {
      runId: "run-1",
      correlationId: fixture.context.correlationId,
      remoteDigest: draft.binding.remoteDigest,
      prNumber,
      limits: { maxRuntimeMs: 1, maxToolCalls: 10, maxPromptTokens: 10 },
      stillAuthorized: () => fixture.live,
    };
    expect(
      budgetStore.begin(repairContext, {
        attemptId: "repair-1",
        headSha: draft.binding.headSha,
        baseSha: draft.binding.baseSha,
        kind: "workspace-edit",
        failureSignatureDigest: "b".repeat(64),
        expectedRevision: null,
      }).status,
    ).toBe("recorded");
    fixture.now += 2;
    const repairController = new CodingRuntimeCiRepairController({
      store: budgetStore,
      readiness: test.options.persistence,
      now: (): number => fixture.now,
      context: (): CiRepairBudgetContext => repairContext,
    });
    expect(repairController.repairBudgetExhausted()).toBe(true);
    const observed = new CiObservationController({
      ...test.options,
      repairBudgetExhausted: (): boolean => repairController.repairBudgetExhausted(),
    });
    expect(await observed.observe()).toMatchObject({
      status: "observed",
      snapshot: { reason: "repair-budget-exhausted", state: "blocked" },
    });
  });
});
