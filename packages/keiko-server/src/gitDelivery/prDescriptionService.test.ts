import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrDescriptionApplicationService } from "./prDescriptionService.js";
import { DescriptionFixture } from "./prDescriptionTestSupport.js";
import type { PrDescriptionPreview } from "./prDescriptionTypes.js";

let fixture: DescriptionFixture;
beforeEach(() => {
  fixture = new DescriptionFixture();
});
afterEach(() => {
  fixture.close();
});
async function preview(): Promise<PrDescriptionPreview> {
  const result = await fixture.service.preview({ language: "en" });
  expect(result.outcome, JSON.stringify(result)).toBe("preview");
  if (result.outcome !== "preview") throw new TypeError("Preview absent");
  return result.preview;
}
async function approved(): Promise<{ review: PrDescriptionPreview; lease: object }> {
  const review = await preview();
  expect(fixture.service.issueApproval(review.proposalId)).toBeDefined();
  const lease = fixture.service.consumeApproval(review.proposalId);
  if (lease === undefined) throw new TypeError("Approval absent");
  return { review, lease };
}
// Wave-3 W3-4 item 3 — wraps the real registry-backed reserve/release with recording spies so the
// tests below can assert the pairing is balanced (every reserve released exactly once on the drop
// paths, none leaked on error paths) without reimplementing the registry.
function instrumentSnapshotReservations(): { reserved: string[]; released: string[] } {
  const reserved: string[] = [];
  const released: string[] = [];
  const original = fixture.options.snapshots;
  Object.assign(fixture.options, {
    snapshots: {
      ...original,
      reserve: (reference: string, scope: object, correlationId: string): boolean => {
        reserved.push(reference);
        return original.reserve?.(reference, scope, correlationId) ?? true;
      },
      release: (reference: string, scope: object, correlationId: string): void => {
        released.push(reference);
        original.release?.(reference, scope, correlationId);
      },
    },
  });
  return { reserved, released };
}

describe("body-only description application", () => {
  it("holds and applies the exact pre-generated artifact without a second generation", async () => {
    const artifact = await fixture.generateArtifact("Selected Chat intent");
    const result = await fixture.service.previewArtifact(artifact);
    expect(result.outcome).toBe("preview");
    if (result.outcome !== "preview") throw new Error("artifact preview absent");
    expect(result.preview.managedRegion).toBe(artifact.markdown);
    expect(result.preview.finalBody).toContain(artifact.markdown);
    fixture.service.issueApproval(result.preview.proposalId);
    const lease = fixture.service.consumeApproval(result.preview.proposalId);
    expect(lease).toBeDefined();
    if (lease === undefined) return;
    await fixture.service.executeApproved(result.preview.proposalId, lease);
    expect(fixture.writes[0]?.body).toContain(artifact.markdown);
  });

  it("retains an artifact captured from the live branch refs that produced its digest", async () => {
    const artifact = await fixture.generateArtifact("Selected Chat intent", {
      baseRef: "main",
      headRef: "feature",
    });

    const result = await fixture.service.previewArtifact(artifact);

    expect(result.outcome).toBe("preview");
    if (result.outcome !== "preview") throw new Error("artifact preview absent");
    expect(result.preview.status.binding.snapshotDigest).toBe(artifact.binding.snapshotDigest);
  });

  it("rejects a same-SHA PR retarget before recapturing the artifact", async () => {
    const artifact = await fixture.generateArtifact("Selected Chat intent", {
      baseRef: "main",
      headRef: "feature",
    });
    fixture.remote = {
      ...fixture.remote,
      identity: { ...fixture.remote.identity, baseRef: "release" },
    };
    let recaptured = false;
    fixture.afterCapture = (): void => {
      recaptured = true;
    };

    await expect(fixture.service.previewArtifact(artifact)).resolves.toEqual({
      outcome: "blocked",
      reason: "stale-snapshot",
    });
    expect(recaptured).toBe(false);
  });

  it("holds a generic draft in the same proposal owner without granting apply authority", async () => {
    const artifact = await fixture.generateArtifact("Generic Workbench draft");
    const held = fixture.service.holdDraftArtifact(artifact, fixture.now);
    if (held === undefined) throw new Error("draft proposal absent");
    expect(held.artifact).toEqual(artifact);
    expect(typeof held.proposalId).toBe("string");
    expect(fixture.service.reviewDraft(held.proposalId)).toEqual(held);
    expect(fixture.service.review(held.proposalId)).toBeUndefined();
    expect(fixture.service.issueApproval(held.proposalId)).toBeUndefined();
    expect(fixture.service.consumeApproval(held.proposalId)).toBeUndefined();
  });

  it("rejects a pre-generated artifact bound to another snapshot", async () => {
    const artifact = await fixture.generateArtifact();
    const stale = {
      ...artifact,
      binding: { ...artifact.binding, snapshotDigest: "f".repeat(64) },
    };
    await expect(fixture.service.previewArtifact(stale)).resolves.toEqual({
      outcome: "blocked",
      reason: "stale-snapshot",
    });
    expect(fixture.writes).toHaveLength(0);
  });

  it("creates a real snapshot and narrative, requires one use approval, preserves outside bytes", async () => {
    const { review, lease } = await approved();
    expect(review.finalBody.startsWith(fixture.remote.body)).toBe(true);
    expect(review.finalBody.match(/Closes #42/gu)).toHaveLength(1);
    expect(review.concurrencyLimitation).toContain("cannot detect an intervening edit");
    const result = await fixture.service.executeApproved(review.proposalId, lease);
    expect(result.outcome).toBe("observed");
    expect(fixture.status?.state).toBe("current");
    expect(fixture.writes).toEqual([
      { ownerAndRepo: "owner/repo", prExternalId: "123", body: review.finalBody },
    ]);
    expect(await fixture.service.executeApproved(review.proposalId, lease)).toEqual({
      outcome: "blocked",
      reason: "approval-invalid",
    });
    expect(fixture.writes).toHaveLength(1);
    const logs = JSON.stringify([...fixture.events, ...fixture.evidence.values()]);
    expect(logs).not.toContain("Human template");
    expect(logs).not.toContain("Change the exported value");
    expect(
      fixture.events.some(
        (event) => event.op === "git.pr-description" && event.correlationId === "description-test",
      ),
    ).toBe(true);
  });
  it.each(["title", "base", "draft", "merge", "command", "args", "snapshot", "authority"])(
    "rejects caller %s",
    async (field) => {
      expect(await fixture.service.preview({ language: "en", [field]: "hostile" })).toEqual({
        outcome: "blocked",
        reason: "invalid-request",
      });
      expect(fixture.writes).toHaveLength(0);
    },
  );
  it.each(["head", "base", "draft", "closed", "body"] as const)(
    "rejects %s drift before any effect",
    async (drift) => {
      const { review, lease } = await approved();
      if (drift === "head")
        fixture.remote = {
          ...fixture.remote,
          identity: { ...fixture.remote.identity, headSha: "c".repeat(40) },
        };
      if (drift === "base")
        fixture.remote = {
          ...fixture.remote,
          identity: { ...fixture.remote.identity, baseRef: "other" },
        };
      if (drift === "draft")
        fixture.remote = {
          ...fixture.remote,
          identity: { ...fixture.remote.identity, isDraft: false },
        };
      if (drift === "closed")
        fixture.remote = {
          ...fixture.remote,
          identity: { ...fixture.remote.identity, state: "closed" },
        };
      if (drift === "body")
        fixture.remote = { ...fixture.remote, body: fixture.remote.body + "human edit" };
      const result = await fixture.service.executeApproved(review.proposalId, lease);
      expect(result).toMatchObject({
        outcome: "blocked",
        reason: drift === "body" ? "body-changed" : "stale-pr",
      });
      expect(fixture.writes).toHaveLength(0);
    },
  );
  it("fails closed when durable intent cannot be recorded", async () => {
    const { review, lease } = await approved();
    fixture.persistence = false;
    expect(await fixture.service.executeApproved(review.proposalId, lease)).toMatchObject({
      outcome: "blocked",
    });
    expect(fixture.writes).toHaveLength(0);
  });
  it.each(["expired", "revoked"])("does not restore %s approval", async (reason) => {
    const { review, lease } = await approved();
    if (reason === "expired") fixture.now += 60_000;
    else fixture.live = false;
    expect(await fixture.service.executeApproved(review.proposalId, lease)).toMatchObject({
      outcome: "blocked",
    });
    expect(fixture.writes).toHaveLength(0);
  });
  it("reconciles lost response without a second write, including process restart", async () => {
    const { review, lease } = await approved();
    fixture.lostResponse = true;
    const result = await fixture.service.executeApproved(review.proposalId, lease);
    expect(result).toMatchObject({
      outcome: "observed",
      status: { state: "current", effect: "reconciled" },
    });
    const fresh = createPrDescriptionApplicationService(fixture.options);
    expect(await fresh.reconcile()).toMatchObject({
      outcome: "observed",
      status: { state: "current", effect: "reconciled" },
    });
    expect(fresh.consumeApproval(review.proposalId)).toBeUndefined();
    expect(fixture.writes).toHaveLength(1);
  });
  it.each(["old", "third"] as const)(
    "classifies %s body after uncertain response without blind retry",
    async (body) => {
      const { review, lease } = await approved();
      fixture.lostResponse = true;
      if (body === "old") fixture.keepOld = true;
      else
        fixture.afterWrite = (): void => {
          fixture.remote = { ...fixture.remote, body: "third party body" };
        };
      expect(await fixture.service.executeApproved(review.proposalId, lease)).toMatchObject({
        outcome: "observed",
        status: {
          state: "failed",
          reason: body === "old" ? "unchanged-after-write" : "recovery-required",
        },
      });
      expect(fixture.writes).toHaveLength(1);
    },
  );
  it("retains uncertain intent but never publishes current after late authority loss", async () => {
    const { review, lease } = await approved();
    fixture.afterWrite = (): void => {
      fixture.live = false;
    };
    expect(await fixture.service.executeApproved(review.proposalId, lease)).toMatchObject({
      outcome: "blocked",
      reason: "authority-denied",
    });
    expect(fixture.status).toMatchObject({ state: "failed", effect: "uncertain" });
    expect(fixture.writes).toHaveLength(1);
  });
});

describe("description authority and transient request integrity", () => {
  it("does not let a returned preview object rewrite the reviewed bytes", async () => {
    const review = await preview();
    const expected = review.finalBody;
    Object.assign(review, { finalBody: "foreign body", managedRegion: "foreign region" });
    fixture.service.issueApproval(review.proposalId);
    const lease = fixture.service.consumeApproval(review.proposalId);
    expect(lease).toBeDefined();
    if (lease === undefined) return;
    await fixture.service.executeApproved(review.proposalId, lease);
    expect(fixture.writes[0]?.body).toBe(expected);
  });
  it("copies request operands before the first await", async () => {
    const request = { language: "en", refinement: "initial" };
    fixture.afterCapture = (): void => {
      request.language = "bad";
      request.refinement = "bad";
    };
    expect(await fixture.service.preview(request)).toMatchObject({ outcome: "preview" });
  });
  it("refuses an accessor request without evaluating its getter", async () => {
    let accessed = false;
    const request = Object.defineProperty({}, "language", {
      enumerable: true,
      get: (): string => {
        accessed = true;
        return "en";
      },
    });
    expect(await fixture.service.preview(request)).toMatchObject({
      outcome: "blocked",
      reason: "invalid-request",
    });
    expect(accessed).toBe(false);
  });
  it("rejects malformed markers and secret content before approval", async () => {
    for (const body of [
      "<!-- keiko:pr-description:v2:start -->",
      "api_key=private-fixture-value",
    ]) {
      fixture.remote = { ...fixture.remote, body };
      expect(await fixture.service.preview({ language: "en" })).toMatchObject({
        outcome: "blocked",
      });
    }
    expect(fixture.writes).toHaveLength(0);
  });
  it("retains the same sole closing directive through a repeat update", async () => {
    const first = await approved();
    await fixture.service.executeApproved(first.review.proposalId, first.lease);
    const next = await approved();
    await fixture.service.executeApproved(next.review.proposalId, next.lease);
    expect(fixture.remote.body.match(/Closes #42/gu)).toHaveLength(1);
    expect(fixture.remote.body.match(/keiko:pr-description:v1:start/gu)).toHaveLength(1);
    expect(fixture.remote.body.startsWith("# Human template\r\n\r\nCloses #42\r\n")).toBe(true);
  });
  it("blocks revoked authority after the awaited live read with no write", async () => {
    const { review, lease } = await approved();
    fixture.beforeRead = (): void => {
      fixture.live = false;
    };
    expect(await fixture.service.executeApproved(review.proposalId, lease)).toMatchObject({
      outcome: "blocked",
      reason: "authority-denied",
    });
    expect(fixture.writes).toHaveLength(0);
  });
  it("refuses caller-independent provider identity drift at preview", async () => {
    fixture.remote = {
      ...fixture.remote,
      identity: {
        ...fixture.remote.identity,
        number: 124,
        url: "https://github.com/owner/repo/pull/124",
      },
    };
    expect(await fixture.service.preview({ language: "en" })).toMatchObject({
      outcome: "blocked",
      reason: "provider-failed",
    });
  });
  it("supplies IPC cancellation to the owning read/effect adapter", async () => {
    const { review, lease } = await approved();
    const controller = new AbortController();
    let adapterSignal: AbortSignal | undefined;
    const original = fixture.options.adapter;
    Object.assign(fixture.options, {
      adapter: (context: Parameters<typeof original>[0]): ReturnType<typeof original> => {
        adapterSignal = context.signal;
        return original(context);
      },
    });
    fixture.beforeRead = (): void => {
      controller.abort();
    };
    expect(
      await fixture.service.executeApproved(review.proposalId, lease, {
        check: () => true,
        signal: controller.signal,
      }),
    ).toMatchObject({ outcome: "blocked", reason: "authority-denied" });
    expect(adapterSignal?.aborted).toBe(true);
    expect(fixture.writes).toHaveLength(0);
  });
});

it("requires a new preview and approval before retrying an unchanged provider body", async () => {
  const first = await approved();
  fixture.keepOld = true;
  fixture.lostResponse = true;
  await fixture.service.executeApproved(first.review.proposalId, first.lease);
  expect(fixture.status?.reason).toBe("unchanged-after-write");
  expect(await fixture.service.reconcile()).toMatchObject({
    outcome: "observed",
    status: { reason: "unchanged-after-write" },
  });
  expect(fixture.writes).toHaveLength(1);
  fixture.keepOld = false;
  fixture.lostResponse = false;
  const next = await approved();
  expect(next.review.proposalId).not.toBe(first.review.proposalId);
  await fixture.service.executeApproved(next.review.proposalId, next.lease);
  expect(fixture.status?.state).toBe("current");
  expect(fixture.writes).toHaveLength(2);
});

it("does not overwrite retained success when a later preview fails", async () => {
  const first = await approved();
  await fixture.service.executeApproved(first.review.proposalId, first.lease);
  const original = fixture.status;
  expect(await fixture.service.preview({ language: "xx" })).toMatchObject({ outcome: "blocked" });
  expect(fixture.status).toEqual(original);
});

it("serializes competing execution and consumes the actual approval once", async () => {
  const first = await approved();
  const original = fixture.options.adapter;
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  Object.assign(fixture.options, {
    adapter: (context: Parameters<typeof original>[0]): ReturnType<typeof original> => {
      const adapter = original(context);
      if (adapter === undefined) return undefined;
      return {
        ...adapter,
        readPullRequestBody: async (request): ReturnType<typeof adapter.readPullRequestBody> => {
          started?.();
          await barrier;
          return adapter.readPullRequestBody(request);
        },
      };
    },
  });
  const effect = fixture.service.executeApproved(first.review.proposalId, first.lease);
  await ready;
  expect(await fixture.service.executeApproved(first.review.proposalId, first.lease)).toMatchObject(
    { outcome: "blocked", reason: "approval-invalid" },
  );
  release?.();
  expect(await effect).toMatchObject({ outcome: "observed", status: { state: "current" } });
  expect(fixture.writes).toHaveLength(1);
});

it("admits only one in-flight generation per service", async () => {
  const original = fixture.options.adapter;
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  Object.assign(fixture.options, {
    adapter: (context: Parameters<typeof original>[0]): ReturnType<typeof original> => {
      const adapter = original(context);
      if (adapter === undefined) return undefined;
      return {
        ...adapter,
        readPullRequestBody: async (request): ReturnType<typeof adapter.readPullRequestBody> => {
          started?.();
          await barrier;
          return adapter.readPullRequestBody(request);
        },
      };
    },
  });
  const first = fixture.service.preview({ language: "en" });
  await ready;
  const competing = fixture.service.preview({ language: "en" });
  release?.();
  expect(await competing).toEqual({ outcome: "blocked", reason: "authority-denied" });
  expect(await first).toMatchObject({ outcome: "preview" });
});

describe("snapshot reservation lifecycle (wave-3 W3-4 item 3)", () => {
  it("refuses preview before model generation when the snapshot cannot be reserved", async () => {
    let modelRequests = 0;
    const generation = fixture.options.generation;
    Object.assign(fixture.options, {
      snapshots: { ...fixture.options.snapshots, reserve: (): boolean => false },
      generation: {
        ...generation,
        gateway: {
          chat: (request: Parameters<typeof generation.gateway.chat>[0]) => {
            modelRequests += 1;
            return generation.gateway.chat(request);
          },
        },
      },
    });

    await expect(fixture.service.preview({ language: "en" })).resolves.toEqual({
      outcome: "blocked",
      reason: "stale-snapshot",
    });
    expect(modelRequests).toBe(0);
    const refusal = fixture.events.find(
      (event) =>
        event.op === "git.pr-description" &&
        event.extra?.phase === "preview" &&
        event.extra.reason === "stale-snapshot",
    );
    expect(refusal).toBeDefined();
  });

  it("reserves the captured reference while held, and releases it when a fresh preview replaces it", async () => {
    const { reserved, released } = instrumentSnapshotReservations();
    const first = await preview();
    expect(reserved).toHaveLength(1);
    expect(released).toHaveLength(0);
    const second = await preview();
    expect(second.proposalId).not.toBe(first.proposalId);
    expect(reserved).toHaveLength(2);
    expect(released).toEqual([reserved[0]]);
  });

  it("releases a held application proposal's reservation when a draft artifact replaces it", async () => {
    const { reserved, released } = instrumentSnapshotReservations();
    await preview();
    expect(reserved).toHaveLength(1);
    const artifact = await fixture.generateArtifact("Generic Workbench draft");
    fixture.service.holdDraftArtifact(artifact, fixture.now);
    expect(released).toEqual(reserved);
  });

  it("releases the held reservation on invalidate", async () => {
    const { reserved, released } = instrumentSnapshotReservations();
    await preview();
    expect(reserved).toHaveLength(1);
    fixture.service.invalidate();
    expect(released).toEqual(reserved);
  });

  it("releases the reservation once a proposal is approved and executed", async () => {
    const { reserved, released } = instrumentSnapshotReservations();
    const { review, lease } = await approved();
    expect(reserved).toHaveLength(1);
    expect(released).toHaveLength(0);
    await fixture.service.executeApproved(review.proposalId, lease);
    expect(released).toEqual(reserved);
  });

  it("keeps the reservation through the execution-time snapshot recheck", async () => {
    const { reserved, released } = instrumentSnapshotReservations();
    const { review, lease } = await approved();
    const snapshots = fixture.options.snapshots;
    let recheckCount = 0;
    Object.assign(fixture.options, {
      snapshots: {
        ...snapshots,
        recheck: async (...args: Parameters<typeof snapshots.recheck>) => {
          // The registry's own eviction regression proves that a reserved reference survives a
          // capacity sweep. At this service boundary, assert the complementary lifecycle fact
          // directly: every real execution-time recheck runs before the service releases it.
          expect(released).toHaveLength(0);
          recheckCount += 1;
          return await snapshots.recheck(...args);
        },
      },
    });

    await expect(fixture.service.executeApproved(review.proposalId, lease)).resolves.toMatchObject({
      outcome: "observed",
    });
    expect(recheckCount).toBeGreaterThan(0);
    expect(fixture.writes).toHaveLength(1);
    expect(released).toEqual(reserved);
  });

  it("releases the reservation when a prepared proposal is discarded before ever being held", async () => {
    const { reserved, released } = instrumentSnapshotReservations();
    // Bumps the service generation right after the snapshot capture that produces the reservation
    // (and therefore before the outer preview flow validates the proposal it prepared), so
    // `previewPrepared` discards the proposal without ever storing it in `this.proposals` — the
    // one path that never gets a release from the drop-site instrumentation above.
    fixture.afterCapture = (): void => {
      fixture.service.invalidate();
    };
    const result = await fixture.service.preview({ language: "en" });
    expect(result).toMatchObject({ outcome: "blocked", reason: "authority-denied" });
    expect(reserved).toHaveLength(1);
    expect(released).toEqual(reserved);
  });
});
