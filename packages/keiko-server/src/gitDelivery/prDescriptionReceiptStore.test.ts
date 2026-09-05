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
import {
  createPrDescriptionReceiptStatusHooks,
  createPrDescriptionReceiptStore,
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
});
