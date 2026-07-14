import { describe, expect, it } from "vitest";
import { isDebugLifecycleEvidence } from "./debug-lifecycle.js";

const valid = {
  schemaVersion: "1",
  eventKind: "start",
  sessionId: "opaque-session",
  state: "starting",
  reason: "requested",
  targetKind: "file",
  backend: "oci",
  network: "none",
  filesystem: "executionRoot",
  provisioningDigest: "a".repeat(64),
  timestampMs: 1,
  activationRevision: 2,
  outputAcceptedBytes: 0,
  outputTruncatedEvents: 0,
};

describe("debug lifecycle evidence", () => {
  it("accepts the closed content-free shape", () => {
    expect(isDebugLifecycleEvidence(valid)).toBe(true);
  });

  it.each(["path", "argv", "env", "output", "expression", "error"])(
    "does not make %s part of the accepted schema",
    (field) => {
      expect(isDebugLifecycleEvidence({ ...valid, [field]: "secret" })).toBe(false);
    },
  );

  it("rejects invalid provisioning digests without throwing", () => {
    expect(() =>
      isDebugLifecycleEvidence({ ...valid, provisioningDigest: "secret" }),
    ).not.toThrow();
    expect(isDebugLifecycleEvidence({ ...valid, provisioningDigest: "secret" })).toBe(false);
  });

  it.each([
    ["unknown event", { eventKind: "other" }],
    ["unknown state", { state: "other" }],
    ["unknown reason", { reason: "other" }],
    ["overlong id", { sessionId: "a".repeat(129) }],
    ["negative revision", { activationRevision: -1 }],
    ["negative count", { outputAcceptedBytes: -1 }],
    ["NaN timestamp", { timestampMs: Number.NaN }],
    ["fractional count", { outputTruncatedEvents: 1.5 }],
  ])("rejects %s", (_label, replacement) => {
    expect(isDebugLifecycleEvidence({ ...valid, ...replacement })).toBe(false);
  });

  it("accepts restart-throttled failure evidence as a closed terminal vocabulary", () => {
    expect(
      isDebugLifecycleEvidence({
        ...valid,
        eventKind: "failure",
        state: "restartThrottled",
        reason: "restartThrottled",
      }),
    ).toBe(true);
  });

  it.each(["start", "active", "stop", "failure", "session-revoked", "teardown"])(
    "accepts closed event kind %s",
    (eventKind) => {
      expect(isDebugLifecycleEvidence({ ...valid, eventKind })).toBe(true);
    },
  );

  it.each([
    "reserved",
    "starting",
    "running",
    "paused",
    "stopping",
    "stopped",
    "failed",
    "revoked",
    "terminationPending",
    "restartThrottled",
  ])("accepts closed state %s", (state) => {
    expect(isDebugLifecycleEvidence({ ...valid, state })).toBe(true);
  });

  it.each([
    "requested",
    "adapterExit",
    "debuggeeExit",
    "malformedFrame",
    "frameOverflow",
    "outputOverflow",
    "wallTimeout",
    "inactivityTimeout",
    "activationRevoked",
    "serverShutdown",
    "startupFailed",
    "restartThrottled",
    "writeFailure",
    "unexpectedEof",
    "stopped",
  ])("accepts closed reason %s", (reason) => {
    expect(isDebugLifecycleEvidence({ ...valid, reason })).toBe(true);
  });

  it.each(["catalog", "file"])("accepts target kind %s", (targetKind) => {
    expect(isDebugLifecycleEvidence({ ...valid, targetKind })).toBe(true);
  });

  it.each(["oci", "linuxNamespace", "windowsContainer"])("accepts backend %s", (backend) => {
    expect(isDebugLifecycleEvidence({ ...valid, backend })).toBe(true);
  });

  it.each([
    ["schemaVersion", "2"],
    ["sessionId", "!opaque"],
    ["sessionId", "opaque!"],
    ["sessionId", ""],
    ["provisioningDigest", "A".repeat(64)],
    ["targetKind", "other"],
    ["backend", "other"],
    ["network", "host"],
    ["filesystem", "host"],
  ])("rejects hostile %s independently", (field, value) => {
    expect(isDebugLifecycleEvidence({ ...valid, [field]: value })).toBe(false);
  });

  it.each(["eventKind", "state", "reason", "sessionId", "provisioningDigest"])(
    "rejects a non-string %s",
    (field) => {
      expect(isDebugLifecycleEvidence({ ...valid, [field]: 1 })).toBe(false);
    },
  );

  it.each(["timestampMs", "activationRevision", "outputAcceptedBytes", "outputTruncatedEvents"])(
    "requires a nonnegative safe integer for %s",
    (field) => {
      for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "1"]) {
        expect(isDebugLifecycleEvidence({ ...valid, [field]: value })).toBe(false);
      }
    },
  );

  it.each(Object.keys(valid))("requires exact key %s", (field) => {
    const candidate = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));
    expect(isDebugLifecycleEvidence(candidate)).toBe(false);
  });

  it.each([null, [], "value", 1, true])("rejects non-record evidence", (value) => {
    expect(isDebugLifecycleEvidence(value)).toBe(false);
  });

  it("rejects arrays even when hostile properties mimic every evidence field", () => {
    expect(isDebugLifecycleEvidence(Object.assign([], valid))).toBe(false);
  });

  it("does not coerce an object-shaped provisioning digest", () => {
    const provisioningDigest = { toString: (): string => "a".repeat(64) };
    expect(isDebugLifecycleEvidence({ ...valid, provisioningDigest })).toBe(false);
  });

  it("rejects callable values even when hostile properties mimic evidence", () => {
    const callable = Object.assign((): void => undefined, valid);
    expect(isDebugLifecycleEvidence(callable)).toBe(false);
  });
});
