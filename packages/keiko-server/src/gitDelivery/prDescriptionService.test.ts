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
describe("body-only description application", () => {
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
