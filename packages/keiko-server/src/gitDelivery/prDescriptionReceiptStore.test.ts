import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createInMemoryEvidenceStore,
  createNodeEvidenceStore,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import type { PrDescriptionApplicationStatus } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import { DescriptionFixture } from "./prDescriptionTestSupport.js";
import { applicationStatus } from "./prDescriptionProjection.js";
import { createPrDescriptionApplicationService } from "./prDescriptionService.js";
import {
  createPrDescriptionReceiptStatusHooks,
  createPrDescriptionReceiptStore,
  MAX_DOCUMENTS,
} from "./prDescriptionReceiptStore.js";
import type { PrDescriptionReceiptRead } from "./prDescriptionReceiptTypes.js";

function version(read: PrDescriptionReceiptRead): string | null {
  if (!read.ok) throw new TypeError("Receipt unavailable");
  return read.version;
}
describe.each(["memory", "file"] as const)(
  "description receipt CAS in existing %s evidence store",
  (kind) => {
    let fixture: DescriptionFixture;
    let evidence: EvidenceStore;
    let store: ReturnType<typeof createPrDescriptionReceiptStore>;
    let journal: PrDescriptionApplicationStatus;
    beforeEach(async () => {
      fixture = new DescriptionFixture();
      const preview = await fixture.service.preview({ language: "en" });
      if (preview.outcome !== "preview") throw new TypeError("Missing actual preview");
      journal = applicationStatus(
        preview.preview.status.binding,
        "complete",
        "recovery-required",
        "uncertain",
        fixture.now,
      );
      evidence =
        kind === "memory"
          ? createInMemoryEvidenceStore()
          : createNodeEvidenceStore(join(fixture.root, "evidence"));
      store = createPrDescriptionReceiptStore({
        evidenceStore: evidence,
        now: () => fixture.now,
        redact: (value) => value,
        log: { write: (event) => fixture.events.push(event) },
      });
    });
    afterEach(() => {
      fixture.close();
    });
    it("requires explicit absence then consumes each exact version, including identical observations", () => {
      expect(store.readStatus(fixture.context)).toEqual({ ok: true, version: null });
      const first = store.recordStatus(fixture.context, journal, null);
      expect(first.ok).toBe(true);
      expect(store.recordStatus(fixture.context, journal, null)).toEqual({
        ok: false,
        reason: "receipt-conflict",
      });
      const next = store.recordStatus(fixture.context, journal, version(first));
      expect(version(next)).not.toBe(version(first));
      expect(store.recordStatus(fixture.context, journal, version(first))).toEqual({
        ok: false,
        reason: "receipt-conflict",
      });
      expect(evidence.list()).toHaveLength(1);
    });
    it("retains uncertain provenance across a new store instance and denies an unrelated intent", () => {
      const first = store.recordStatus(fixture.context, journal, null);
      const fresh = createPrDescriptionReceiptStore({
        evidenceStore: evidence,
        now: () => fixture.now,
        redact: (value) => value,
      });
      expect(fresh.readStatus(fixture.context)).toEqual(first);
      const foreign = { ...journal, binding: { ...journal.binding, draftDigest: "1".repeat(64) } };
      expect(fresh.recordStatus(fixture.context, foreign, version(first))).toEqual({
        ok: false,
        reason: "receipt-conflict",
      });
      expect(fresh.readStatus(fixture.context)).toEqual(first);
    });
    it("publishes success only from its own journal and retains it against stale completions", () => {
      const complete = applicationStatus(
        journal.binding,
        "complete",
        "applied",
        "confirmed",
        fixture.now,
      );
      expect(store.recordStatus(fixture.context, complete, null)).toEqual({
        ok: false,
        reason: "receipt-conflict",
      });
      const first = store.recordStatus(fixture.context, journal, null);
      const success = store.recordStatus(fixture.context, complete, version(first));
      expect(success).toMatchObject({ ok: true, status: { state: "current" } });
      expect(store.recordStatus(fixture.context, journal, version(first))).toEqual({
        ok: false,
        reason: "receipt-conflict",
      });
      expect(store.readStatus(fixture.context)).toEqual(success);
    });
    // #3390: marking the pull request ready changes its identity (`isDraft`) without moving the
    // change. The effect layer re-binds the confirmed content to the ready identity through the
    // contract's `isObservedReadyRebinding`; this store must admit exactly that rebinding of a
    // confirmed receipt -- and still refuse every other binding change on it.
    it("admits the observed draft-to-ready rebinding of a confirmed receipt and nothing else", () => {
      const first = store.recordStatus(fixture.context, journal, null);
      const applied = applicationStatus(
        journal.binding,
        "complete",
        "applied",
        "confirmed",
        fixture.now,
      );
      const confirmed = store.recordStatus(fixture.context, applied, version(first));
      expect(confirmed.ok).toBe(true);
      const ready = {
        ...journal.binding,
        isDraft: false,
        providerUpdatedAt: new Date(fixture.now).toISOString(),
      };
      const reconciled = applicationStatus(
        ready,
        "complete",
        "reconciled",
        "reconciled",
        fixture.now,
      );
      const observed = store.recordStatus(fixture.context, reconciled, version(confirmed));
      expect(observed).toMatchObject({
        ok: true,
        status: { state: "current", effect: "reconciled", binding: { isDraft: false } },
      });
      for (const foreign of [
        { ...ready, headSha: "c".repeat(40) },
        { ...ready, baseRef: "release" },
        { ...ready, finalBodyDigest: "0".repeat(64) },
        { ...journal.binding },
      ]) {
        const moved = applicationStatus(
          foreign,
          "complete",
          "reconciled",
          "reconciled",
          fixture.now,
        );
        expect(store.recordStatus(fixture.context, moved, version(observed))).toEqual({
          ok: false,
          reason: "receipt-conflict",
        });
      }
      expect(store.readStatus(fixture.context)).toEqual(observed);
    });
    it("rejects revoked context, foreign source and hostile nested fields without changing prior bytes", () => {
      const first = store.recordStatus(fixture.context, journal, null);
      const id = evidence.list()[0] ?? "";
      const original = evidence.get(id);
      for (const binding of [
        { ...journal.binding, repositoryId: "foreign" },
        { ...journal.binding, remoteDigest: "1".repeat(64) },
        { ...journal.binding, prExternalId: "PR_foreign" },
        { ...journal.binding, body: "secret" },
      ]) {
        expect(
          store.recordStatus(fixture.context, { ...journal, binding }, version(first)).ok,
        ).toBe(false);
        expect(evidence.get(id)).toBe(original);
      }
      fixture.live = false;
      expect(store.recordStatus(fixture.context, journal, version(first)).ok).toBe(false);
      expect(evidence.get(id)).toBe(original);
    });
    it("never resets corrupt or over-bound existing documents", () => {
      const first = store.recordStatus(fixture.context, journal, null);
      const id = evidence.list()[0] ?? "";
      for (const corrupt of [
        "{broken",
        "x".repeat(8193),
        JSON.stringify({ schemaVersion: "1", revision: 1, status: { body: "secret" } }),
      ]) {
        evidence.put(id, corrupt);
        expect(store.readStatus(fixture.context)).toEqual({
          ok: false,
          reason: "storage-unavailable",
        });
        expect(store.recordStatus(fixture.context, journal, version(first))).toEqual({
          ok: false,
          reason: "storage-unavailable",
        });
        expect(evidence.get(id)).toBe(corrupt);
      }
    });
    it("requires the existing serialized update port and refuses redaction changes", () => {
      const { update, ...withoutUpdate } = evidence;
      expect(update).toBeDefined();
      const unavailable = createPrDescriptionReceiptStore({
        evidenceStore: withoutUpdate,
        now: () => fixture.now,
        redact: (value) => value,
      });
      expect(unavailable.recordStatus(fixture.context, journal, null)).toEqual({
        ok: false,
        reason: "storage-unavailable",
      });
      const redacted = createPrDescriptionReceiptStore({
        evidenceStore: evidence,
        now: () => fixture.now,
        redact: () => "[REDACTED]",
      });
      expect(redacted.recordStatus(fixture.context, journal, null)).toEqual({
        ok: false,
        reason: "storage-unavailable",
      });
      expect(evidence.list()).toHaveLength(0);
    });
  },
);
describe("description receipt status hooks (service option bridge)", () => {
  let fixture: DescriptionFixture;
  let evidence: EvidenceStore;
  let journal: PrDescriptionApplicationStatus;
  beforeEach(async () => {
    fixture = new DescriptionFixture();
    const preview = await fixture.service.preview({ language: "en" });
    if (preview.outcome !== "preview") throw new TypeError("Missing actual preview");
    journal = applicationStatus(
      preview.preview.status.binding,
      "complete",
      "recovery-required",
      "uncertain",
      fixture.now,
    );
    evidence = createInMemoryEvidenceStore();
  });
  afterEach(() => {
    fixture.close();
  });
  function hooksOver(): ReturnType<typeof createPrDescriptionReceiptStatusHooks> {
    return createPrDescriptionReceiptStatusHooks(
      createPrDescriptionReceiptStore({
        evidenceStore: evidence,
        now: () => fixture.now,
        redact: (value) => value,
      }),
    );
  }
  it("persists a recorded status across a recreated service instance sharing the same evidence store", () => {
    const before = hooksOver();
    expect(before.readStatus(fixture.context)).toBeUndefined();
    expect(before.recordStatus(fixture.context, journal)).toBe(true);
    const afterRestart = hooksOver();
    expect(afterRestart.readStatus(fixture.context)).toEqual(journal);
  });
  it("rejects a write from an instance whose cached expected version has gone stale", () => {
    const first = hooksOver();
    expect(first.recordStatus(fixture.context, journal)).toBe(true);
    const second = hooksOver();
    expect(second.readStatus(fixture.context)).toEqual(journal);
    const complete = applicationStatus(
      journal.binding,
      "complete",
      "applied",
      "confirmed",
      fixture.now,
    );
    expect(second.recordStatus(fixture.context, complete)).toBe(true);
    expect(first.recordStatus(fixture.context, complete)).toBe(false);
    expect(first.readStatus(fixture.context)).toEqual(complete);
  });
  it("logs the store's own failure when recordStatus is called through an invalid context", () => {
    const hooks = createPrDescriptionReceiptStatusHooks(
      createPrDescriptionReceiptStore({
        evidenceStore: evidence,
        now: () => fixture.now,
        redact: (value) => value,
        log: { write: (event) => fixture.events.push(event) },
      }),
    );
    fixture.live = false;
    expect(hooks.recordStatus(fixture.context, journal)).toBe(false);
    expect(
      fixture.events.some(
        (event) => event.op === "git.pr-description.receipt" && event.extra?.phase === "record",
      ),
    ).toBe(true);
  });
  it("stays closed when the evidence store cannot serve the durable update port", () => {
    const { update, ...withoutUpdate } = evidence;
    expect(update).toBeDefined();
    const unavailable = createPrDescriptionReceiptStatusHooks(
      createPrDescriptionReceiptStore({
        evidenceStore: withoutUpdate,
        now: () => fixture.now,
        redact: (value) => value,
      }),
    );
    expect(unavailable.recordStatus(fixture.context, journal)).toBe(false);
    expect(unavailable.readStatus(fixture.context)).toBeUndefined();
  });
  it("bounds the in-process version cache and evicts the oldest scope once the cap is exceeded", () => {
    // Insert the target scope's cache entry first, then push MAX_DOCUMENTS distinct filler scopes
    // through the same hooks instance (a bare readStatus on an absent document never writes to the
    // evidence store, so this never touches the store's own MAX_DOCUMENTS document-count ceiling).
    // That crosses the cache's cap by exactly one, which must evict the target — the single oldest
    // entry by insertion order.
    const hooks = hooksOver();
    expect(hooks.recordStatus(fixture.context, journal)).toBe(true);
    for (let index = 0; index < MAX_DOCUMENTS; index += 1) {
      hooks.readStatus({ ...fixture.context, prNumber: 10_000 + index });
    }
    // A second instance (sharing the same evidence store, its own empty cache) advances the
    // target scope behind hooks' back — the observable proof that eviction actually happened.
    const second = hooksOver();
    const complete = applicationStatus(
      journal.binding,
      "complete",
      "applied",
      "confirmed",
      fixture.now,
    );
    expect(second.recordStatus(fixture.context, complete)).toBe(true);
    // If the target's cache entry had NOT been evicted, hooks would still expect the original
    // version and this compare-and-swap would be rejected as a conflict against the real, now
    // newer, stored version. Because it was evicted, the miss forces a fresh read that recovers
    // the current version, so the write is accepted.
    const reconciled = applicationStatus(
      journal.binding,
      "complete",
      "reconciled",
      "reconciled",
      fixture.now,
    );
    expect(hooks.recordStatus(fixture.context, reconciled)).toBe(true);
  });
  // Rehearsal run-12 (#3390): the service applied the description to the draft pull request, the
  // operator marked it ready, and the status refresh then failed as `authority-denied` -- the
  // receipt refused the ready rebinding the effect layer had produced. The service suite alone
  // could not see it: its fixture persists everything. This is the two real layers together.
  it("reconciles an applied description to the ready pull request through the durable receipt", async () => {
    const hooks = hooksOver();
    const service = createPrDescriptionApplicationService({
      ...fixture.options,
      recordStatus: hooks.recordStatus,
      readStatus: hooks.readStatus,
    });
    const preview = await service.preview({ language: "en" });
    if (preview.outcome !== "preview") throw new TypeError("Missing actual preview");
    service.issueApproval(preview.preview.proposalId);
    const lease = service.consumeApproval(preview.preview.proposalId);
    if (lease === undefined) throw new TypeError("Missing approval lease");
    expect(await service.executeApproved(preview.preview.proposalId, lease)).toMatchObject({
      outcome: "observed",
      status: { state: "current", effect: "confirmed", binding: { isDraft: true } },
    });
    fixture.now += 5_000;
    fixture.remote = {
      ...fixture.remote,
      identity: { ...fixture.remote.identity, isDraft: false },
      updatedAt: new Date(fixture.now).toISOString(),
    };
    expect(await service.reconcile()).toMatchObject({
      outcome: "observed",
      status: {
        state: "current",
        reason: "reconciled",
        effect: "reconciled",
        binding: { isDraft: false, headSha: fixture.remote.identity.headSha },
      },
    });
    expect(hooks.readStatus(fixture.context)).toMatchObject({
      effect: "reconciled",
      binding: { isDraft: false },
    });
  });
});
