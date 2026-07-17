import { describe, expect, it } from "vitest";

import {
  validateCodingWorkbenchRuntimeEvent,
  type GovernedActionV1,
} from "@oscharko-dev/keiko-contracts";

import {
  RESEARCH_APPROVAL_TTL_MS,
  buildResearchPermissionEvent,
  createPendingResearchApprovals,
  registerApprovedResearchGrant,
  type ApprovedResearchIssuanceDeps,
} from "./researchApprovalIssuance.js";
import { createResearchEgressPort, researchRequestLineDigest } from "./researchEgressPort.js";
import { createResearchGrantRegistry } from "./researchGrantRegistry.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";

const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const APPROVAL_DIGEST = "b".repeat(64);
const RUN = "run-1";
const LIVE_GUARD = { check: (): boolean => true };

function askFor(
  url: string,
  runId = RUN,
): {
  readonly pending: ReturnType<typeof createPendingResearchApprovals>;
  readonly requestId: string | undefined;
} {
  const pending = createPendingResearchApprovals();
  const requestId = pending.request({
    runId,
    url: new URL(url),
    taskId: "task-1",
    workspaceId: "workspace-1",
    nowMs: NOW_MS,
  });
  return { pending, requestId };
}

describe("pending research approvals", () => {
  it("retains one https public URL per run and mints a sequenced request id", () => {
    const { pending, requestId } = askFor("https://docs.example.org/guide?q=streams");

    expect(requestId).toBe("research-approval-1");
    const consumed = pending.consume(RUN, "research-approval-1", NOW_MS + 1);
    expect(consumed?.url.toString()).toBe("https://docs.example.org/guide?q=streams");
    expect(consumed?.taskId).toBe("task-1");
    expect(consumed?.workspaceId).toBe("workspace-1");
  });

  it("refuses a second ask while one is pending, then admits a fresh one after expiry", () => {
    const { pending } = askFor("https://docs.example.org/");

    const racing = pending.request({
      runId: RUN,
      url: new URL("https://other.example.net/"),
      taskId: "task-1",
      workspaceId: "workspace-1",
      nowMs: NOW_MS + 1,
    });
    expect(racing).toBeUndefined();

    const afterExpiry = pending.request({
      runId: RUN,
      url: new URL("https://other.example.net/"),
      taskId: "task-1",
      workspaceId: "workspace-1",
      nowMs: NOW_MS + RESEARCH_APPROVAL_TTL_MS + 1,
    });
    expect(afterExpiry).toBe("research-approval-2");
  });

  it.each([
    ["http scheme", "http://docs.example.org/"],
    ["embedded credentials", "https://user:pw@docs.example.org/"],
    ["explicit port", "https://docs.example.org:8443/"],
    ["ip literal host", "https://192.168.0.10/"],
    ["loopback name", "https://localhost/"],
  ])("refuses to retain a URL with %s", (_label, url) => {
    const { requestId } = askFor(url);
    expect(requestId).toBeUndefined();
  });

  it("consume is one-shot and fails closed on mismatch, expiry, and replay", () => {
    const { pending } = askFor("https://docs.example.org/");

    // A mismatched request id burns the pending ask instead of leaving it consumable.
    expect(pending.consume(RUN, "research-approval-9", NOW_MS)).toBeUndefined();
    expect(pending.consume(RUN, "research-approval-1", NOW_MS)).toBeUndefined();

    const second = askFor("https://docs.example.org/");
    expect(
      second.pending.consume(RUN, "research-approval-1", NOW_MS + RESEARCH_APPROVAL_TTL_MS),
    ).toBeUndefined();
  });

  it("invalidateRun drops the pending ask", () => {
    const { pending } = askFor("https://docs.example.org/");
    pending.invalidateRun(RUN);
    expect(pending.consume(RUN, "research-approval-1", NOW_MS)).toBeUndefined();
  });
});

describe("buildResearchPermissionEvent", () => {
  it("builds a validated, content-free permission-requested event", () => {
    const event = buildResearchPermissionEvent({
      runId: RUN,
      requestId: "research-approval-1",
      sequence: 1,
      nowMs: NOW_MS,
    });

    expect(event).toBeDefined();
    expect(validateCodingWorkbenchRuntimeEvent(event).ok).toBe(true);
    expect(event?.kind).toBe("permission-requested");
    expect(event?.permissionRequest).toMatchObject({
      requestId: "research-approval-1",
      kind: "network-egress",
      actionClass: "network-egress",
      actionKind: "research",
    });
    // Content-free: never the URL, host, path, or query.
    expect(JSON.stringify(event)).not.toContain("example");
    expect(JSON.stringify(event)).not.toContain("https");
  });
});

describe("registerApprovedResearchGrant", () => {
  function issuanceFixture(url: string): {
    readonly deps: ApprovedResearchIssuanceDeps;
    readonly registry: ReturnType<typeof createResearchGrantRegistry>;
    readonly governed: GovernedActionV1[];
    readonly requestId: string;
  } {
    const { pending, requestId } = askFor(url);
    if (requestId === undefined) throw new Error("fixture url must be retainable");
    const registry = createResearchGrantRegistry();
    const governed: GovernedActionV1[] = [];
    return {
      deps: {
        pending,
        registry,
        now: () => new Date(NOW_MS + 1_000),
        onGovernedAction: (action) => governed.push(action),
      },
      registry,
      governed,
      requestId,
    };
  }

  it("mints a grant the egress executor accepts for exactly the approved URL", async () => {
    const url = "https://docs.example.org/guide/streams?version=24";
    const f = issuanceFixture(url);

    registerApprovedResearchGrant(
      f.deps,
      { runId: RUN, requestId: f.requestId, boundRevision: 4 },
      APPROVAL_DIGEST,
      NOW_MS + 300_000,
    );

    const grants = f.registry.activeGrants(RUN, NOW_MS + 2_000);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      grantId: "research-grant-1",
      domains: ["docs.example.org"],
      queryTextDigest: researchRequestLineDigest(new URL(url)),
      approvalDigest: APPROVAL_DIGEST,
    });

    // Round-trip through the real executor: the approved URL fetches; a sibling path is denied.
    const events: unknown[] = [];
    const port = createResearchEgressPort({
      registry: f.registry,
      resolveRunId: () => RUN,
      gatewayEgress: () => undefined,
      emitEvent: (event) => events.push(event),
      now: () => NOW_MS + 2_000,
      fetchImpl: () => Promise.resolve(new Response("page", { status: 200 })),
    });
    const guard: CodingToolMutationGuard = LIVE_GUARD;
    const approved = await port.execute(
      { actionId: "a-1", idempotencyKey: "k-1", action: "egress", target: url },
      undefined,
      guard,
    );
    const sibling = await port.execute(
      {
        actionId: "a-2",
        idempotencyKey: "k-2",
        action: "egress",
        target: "https://docs.example.org/guide/other",
      },
      undefined,
      guard,
    );
    expect(approved).toMatchObject({ status: "completed" });
    expect(sibling).toEqual({ status: "failed" });
  });

  it("emits the validated read-only-research GovernedActionV1 with the bound revision", () => {
    const f = issuanceFixture("https://docs.example.org/");

    registerApprovedResearchGrant(
      f.deps,
      { runId: RUN, requestId: f.requestId, boundRevision: 7 },
      APPROVAL_DIGEST,
      NOW_MS + 300_000,
    );

    expect(f.governed).toHaveLength(1);
    expect(f.governed[0]).toMatchObject({
      kind: "governed-action",
      actionKind: "read-only-research",
      decision: "allowed",
      runId: RUN,
      taskId: "task-1",
      workspaceId: "workspace-1",
      stateRevision: 7,
      grant: { outcome: "known", value: { grantId: "research-grant-1", grantScope: "once" } },
      question: { outcome: "absent" },
    });
  });

  it("mints nothing when no ask is pending, when it expired, or when the request id mismatches", () => {
    const f = issuanceFixture("https://docs.example.org/");

    registerApprovedResearchGrant(
      f.deps,
      { runId: RUN, requestId: "research-approval-99" },
      APPROVAL_DIGEST,
      NOW_MS + 300_000,
    );
    expect(f.registry.activeGrants(RUN, NOW_MS + 2_000)).toEqual([]);
    expect(f.governed).toEqual([]);

    // The mismatch above burned the ask: the correct id can no longer mint either (one-shot).
    registerApprovedResearchGrant(
      f.deps,
      { runId: RUN, requestId: f.requestId },
      APPROVAL_DIGEST,
      NOW_MS + 300_000,
    );
    expect(f.registry.activeGrants(RUN, NOW_MS + 2_000)).toEqual([]);
  });

  it("mints nothing for a run that never asked", () => {
    const f = issuanceFixture("https://docs.example.org/");

    registerApprovedResearchGrant(
      f.deps,
      { runId: "run-2", requestId: f.requestId },
      APPROVAL_DIGEST,
      NOW_MS + 300_000,
    );

    expect(f.registry.activeGrants("run-2", NOW_MS + 2_000)).toEqual([]);
  });
});
