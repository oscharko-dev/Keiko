import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { privateJiraCustodyFixture as fixture } from "../../../tests/support/jira-private-custody-fixture.js";
import { JiraHumanInputCustodyError } from "./jira-human-input-custody.js";
import { humanInputReference } from "./jira-human-input-values.js";

const PRINCIPAL = "a".repeat(64);
const PRIVATE_VALUE = ["synthetic", "human", "only", "value"].join(" ");
function errorCode(work: () => unknown): string {
  try { work(); } catch (error) {
    if (error instanceof JiraHumanInputCustodyError) return error.code;
    throw error;
  }
  throw new TypeError("Expected private input refusal");
}
describe("human input on existing Atlassian custody", () => {
  it("returns only a non-secret view and an immutable random revision", () => {
    const f = fixture(); const pending = f.inputs.prepare(f.binding);
    const ready = f.inputs.submit(pending.requestId, f.binding, pending.revision, { currentPassword: PRIVATE_VALUE, password: PRIVATE_VALUE + " next" });
    expect(ready).toMatchObject({ state: "ready", purpose: "update-my-password", fields: ["currentPassword", "password"] });
    expect(ready.revision).not.toBe(pending.revision);
    expect(JSON.stringify(ready)).not.toContain(PRIVATE_VALUE);
    expect(JSON.stringify(ready)).not.toContain(createHash("sha256").update(PRIVATE_VALUE).digest("hex"));
    expect(f.inputs.bindingFor(pending.requestId, PRINCIPAL)).toEqual(f.binding);
    expect(JSON.stringify(f.inputs.bindingFor(pending.requestId, PRINCIPAL))).not.toContain(PRIVATE_VALUE);
    expect(errorCode(() => f.inputs.submit(pending.requestId, f.binding, ready.revision, { currentPassword: PRIVATE_VALUE, password: "replacement" }))).toBe("not-pending");
  });
  it("durably consumes before returning private material and cannot replay from retained sealed state", () => {
    const f = fixture(); const pending = f.inputs.prepare(f.binding);
    const ready = f.inputs.submit(pending.requestId, f.binding, pending.revision, { currentPassword: PRIVATE_VALUE, password: PRIVATE_VALUE + " next" });
    expect(errorCode(() => f.privateInputs.claim(pending.requestId, f.binding, pending.revision))).toBe("not-ready");
    const values = f.privateInputs.claim(pending.requestId, f.binding, ready.revision);
    expect(values.password).toBe(PRIVATE_VALUE + " next");
    const ref = humanInputReference(pending.requestId); if (ref === undefined) throw new TypeError("Missing reference");
    expect(f.sealedPortEntries.get(ref)).not.toContain(PRIVATE_VALUE);
    expect(f.inputs.prepare(f.binding)).toMatchObject({ state: "consumed" });
    expect(errorCode(() => f.privateInputs.claim(pending.requestId, f.binding, ready.revision))).toBe("not-ready");
  });
  it("refuses foreign principals, unknown IDs, purpose drift and changed arguments", () => {
    const f = fixture(); const pending = f.inputs.prepare(f.binding);
    expect(f.inputs.bindingFor(pending.requestId, "c".repeat(64))).toBeUndefined();
    expect(f.inputs.bindingFor("invalid", PRINCIPAL)).toBeUndefined();
    for (const delta of [{ argumentsDigest: "c".repeat(64) }, { operation: "jira.login" as const }, { actorUserKey: "other-key" },
      { authority: { runId: "other-run", envelopeDigest: "d".repeat(64) } }, { authority: { runId: "authority-run-1", envelopeDigest: "e".repeat(64) } }])
      expect(errorCode(() => f.inputs.submit(pending.requestId, { ...f.binding, ...delta }, pending.revision, { password: PRIVATE_VALUE }))).toBe("binding-changed");
  });
  it("refuses a sealed record relabelled for a different operation", () => {
    const f = fixture(); const pending = f.inputs.prepare(f.binding);
    const ref = humanInputReference(pending.requestId); if (ref === undefined) throw new TypeError("Missing reference");
    const record = f.sealedPortEntries.get(ref); if (record === undefined) throw new TypeError("Missing sealed test record");
    f.sealedPortEntries.set(ref, record.replace('"operation":"jira.update-my-password"', '"operation":"jira.login"'));
    expect(f.inputs.bindingFor(pending.requestId, PRINCIPAL)).toBeUndefined();
  });
  it("expires and removes values without guessing a fresh expiry during lookup", () => {
    const f = fixture(); const pending = f.inputs.prepare(f.binding);
    const ready = f.inputs.submit(pending.requestId, f.binding, pending.revision, { currentPassword: PRIVATE_VALUE, password: PRIVATE_VALUE });
    f.advance(60_000);
    expect(f.inputs.bindingFor(pending.requestId, PRINCIPAL)).toBeUndefined();
    expect(f.inputs.inspect(pending.requestId, f.binding)).toMatchObject({ state: "expired" });
    expect(errorCode(() => f.privateInputs.claim(pending.requestId, f.binding, ready.revision))).toBe("expired");
    expect([...f.sealedPortEntries.values()].join("")).not.toContain(PRIVATE_VALUE);
    expect(f.clearedPhases).toEqual(["expired"]);
  });
  it("revokes readiness when the existing connector verification revision changes", () => {
    const f = fixture(); const pending = f.inputs.prepare(f.binding);
    f.custody.beginVerification(f.binding.authRef, 1);
    expect(f.inputs.bindingFor(pending.requestId, PRINCIPAL)).toBeUndefined();
    expect(errorCode(() => f.inputs.inspect(pending.requestId, f.binding))).toBe("binding-changed");
  });
  it("allows only the owning principal to clear a ready input after credential revocation", () => {
    const f = fixture("jira.login"); const pending = f.inputs.prepare(f.binding);
    f.inputs.submit(pending.requestId, f.binding, pending.revision, { password: PRIVATE_VALUE });
    f.custody.beginVerification(f.binding.authRef, 1);
    expect(f.inputs.cancelOwned(pending.requestId, "c".repeat(64))).toBeUndefined();
    expect([...f.sealedPortEntries.values()].join("")).toContain(PRIVATE_VALUE);
    expect(f.inputs.cancelOwned(pending.requestId, PRINCIPAL)?.state).toBe("cancelled");
    expect([...f.sealedPortEntries.values()].join("")).not.toContain(PRIVATE_VALUE);
    expect(f.inputs.cancel(pending.requestId, f.binding)?.state).toBe("cancelled");
    expect(f.clearedPhases).toEqual(["cancelled"]);
  });
  it("emits expiry once after the actual CAS and reclaims expired ready input through the same bounded sweep", () => {
    const f = fixture("jira.login"); const pending = f.inputs.prepare(f.binding);
    f.inputs.submit(pending.requestId, f.binding, pending.revision, { password: PRIVATE_VALUE });
    f.advance(60_000);
    const restarted = f.fork().custody.humanInputs;
    if (restarted === undefined) throw new TypeError("Missing restarted custody");
    restarted.sweepExpired(); restarted.sweepExpired();
    expect([...f.sealedPortEntries.values()].join("")).not.toContain(PRIVATE_VALUE);
    expect(restarted.cancelOwned(pending.requestId, PRINCIPAL)).toBeUndefined();
    expect(f.clearedPhases).toEqual(["expired"]);
  });
  it("does not report expiry when the vault refuses the transition CAS", () => {
    const f = fixture("jira.login"); const pending = f.inputs.prepare(f.binding);
    f.inputs.submit(pending.requestId, f.binding, pending.revision, { password: PRIVATE_VALUE });
    f.advance(60_000); f.vault.compareAndSet = () => false;
    expect(errorCode(() => f.inputs.inspect(pending.requestId, f.binding))).toBe("not-pending");
    expect(f.clearedPhases).toEqual([]);
  });
  it("refuses a changed plaintext reread before CAS without retaining the original serialized secret", () => {
    const f = fixture("jira.login"); const pending = f.inputs.prepare(f.binding);
    const ready = f.inputs.submit(pending.requestId, f.binding, pending.revision, { password: PRIVATE_VALUE });
    const ref = humanInputReference(ready.requestId); if (ref === undefined) throw new TypeError("Missing reference");
    const get = f.vault.get; let reads = 0;
    f.vault.get = (key) => {
      if (key === ref && ++reads === 2) {
        const original = get(key); if (original === undefined) throw new TypeError("Missing ready record");
        f.sealedPortEntries.set(key, original.replace(PRIVATE_VALUE, "synthetic changed private value"));
      }
      return get(key);
    };
    expect(errorCode(() => f.privateInputs.claim(ready.requestId, f.binding, ready.revision))).toBe("not-pending");
    expect(f.inputs.cancelOwned(ready.requestId, PRINCIPAL)?.state).toBe("cancelled");
  });
  it("retains consumed/cancelled tombstones until expiry, then reclaims only expired Jira input records", () => {
    const f = fixture("jira.login"); const pending = f.inputs.prepare(f.binding);
    const ready = f.inputs.submit(pending.requestId, f.binding, pending.revision, { password: PRIVATE_VALUE });
    f.privateInputs.claim(ready.requestId, f.binding, ready.revision);
    const other = { ...f.binding, argumentsDigest: "c".repeat(64) };
    const cancelled = f.inputs.prepare(other); f.inputs.cancel(cancelled.requestId, other);
    expect(f.inputs.prepare(f.binding).state).toBe("consumed");
    expect(f.inputs.prepare(other).state).toBe("cancelled");
    const credentialReferences = [...f.sealedPortEntries.keys()].filter((key) => !key.startsWith("jira-input:"));
    f.advance(60_000);
    expect(errorCode(() => f.inputs.prepare(f.binding))).toBe("expired");
    f.inputs.prepare({ ...f.binding, argumentsDigest: "d".repeat(64), expiresAt: f.binding.expiresAt + 60_000 });
    expect(f.sealedPortEntries.has(humanInputReference(ready.requestId) ?? "")).toBe(false);
    expect(f.sealedPortEntries.has(humanInputReference(cancelled.requestId) ?? "")).toBe(false);
    for (const reference of credentialReferences) expect(f.sealedPortEntries.has(reference)).toBe(true);
  });
  it("bounds live sealed inputs across custody instances without dropping unexpired records", () => {
    const f = fixture("jira.login");
    for (let index = 0; index < 128; index++) f.inputs.prepare({ ...f.binding, argumentsDigest: index.toString(16).padStart(64, "0") });
    const other = f.fork().custody.humanInputs; if (other === undefined) throw new TypeError("Missing human input owner");
    expect(() => other.prepare(f.binding)).toThrow("capacity is unavailable");
    expect([...f.sealedPortEntries.keys()].filter((key) => key.startsWith("jira-input:"))).toHaveLength(128);
    f.advance(60_000);
    expect(other.prepare({ ...f.binding, expiresAt: f.binding.expiresAt + 60_000 }).state).toBe("awaiting-input");
    expect([...f.sealedPortEntries.keys()].filter((key) => key.startsWith("jira-input:"))).toHaveLength(1);
  });
  it("accepts only the explicit human shutdown confirmation for the bound unlock purpose", () => {
    const f = fixture("jira.unlock-user-anonymization"); const pending = f.inputs.prepare(f.binding);
    for (const value of [true, "true", "confirmed ", "OFFLINE", undefined])
      expect(errorCode(() => f.inputs.submit(pending.requestId, f.binding, pending.revision, { ownerShutdownConfirmation: value }))).toBe("invalid-input");
    const ready = f.inputs.submit(pending.requestId, f.binding, pending.revision, { ownerShutdownConfirmation: "confirmed" });
    expect(f.privateInputs.claim(ready.requestId, f.binding, ready.revision)).toEqual({ ownerShutdownConfirmation: "confirmed" });
    expect(errorCode(() => f.privateInputs.claim(ready.requestId, f.binding, ready.revision))).toBe("not-ready");
  });
  it("continues the same held call after human input without a write approval", async () => {
    const f = fixture("jira.login"); const pending = f.inputs.prepare(f.binding);
    const waiting = f.inputs.wait(pending.requestId, f.binding, new AbortController().signal);
    f.inputs.submit(pending.requestId, f.binding, pending.revision, { password: PRIVATE_VALUE });
    await expect(waiting).resolves.toMatchObject({ requestId: pending.requestId, state: "ready" });
  });
  it("cancels the held call and forbids subsequent secret submission", async () => {
    const f = fixture("jira.login"); const pending = f.inputs.prepare(f.binding); const controller = new AbortController();
    const waiting = f.inputs.wait(pending.requestId, f.binding, controller.signal); controller.abort();
    await expect(waiting).resolves.toMatchObject({ state: "cancelled" });
    expect(errorCode(() => f.inputs.submit(pending.requestId, f.binding, pending.revision, { password: PRIVATE_VALUE }))).toBe("not-pending");
  });
  it.each([{ password: "" }, { password: "x".repeat(4097) }, { password: "\ud800" }, { password: PRIVATE_VALUE, url: "https://foreign.invalid" }, { license: PRIVATE_VALUE }])("refuses incompatible human fields without echoing them %#", (values) => {
    const f = fixture("jira.login"); const pending = f.inputs.prepare(f.binding);
    expect(errorCode(() => f.inputs.submit(pending.requestId, f.binding, pending.revision, values))).toBe("invalid-input");
    expect(f.inputs.inspect(pending.requestId, f.binding)).toMatchObject({ state: "awaiting-input" });
  });
});
