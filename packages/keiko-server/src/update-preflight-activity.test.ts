import { describe, expect, it } from "vitest";
import {
  recordPortableFetchFailure,
  recordPortableRedirectRefusal,
  recordReleaseTrustFailure,
  recordReleaseTrustSuccess,
} from "./update-preflight-activity.js";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

function capture(): {
  readonly events: ServerLogEvent[];
  readonly sink: { readonly write: (event: ServerLogEvent) => void };
} {
  const events: ServerLogEvent[] = [];
  return {
    events,
    sink: {
      write: (event): void => {
        events.push(event);
      },
    },
  };
}

describe("portable asset redirect refusal activity", () => {
  it("resolves the update.portable-asset.redirect-refused Activity Log proof", () => {
    const { events, sink } = capture();
    recordPortableRedirectRefusal(
      sink,
      "linux-x64",
      "manifest",
      "unsafe-target",
      "preflight-redirect-0001",
    );
    const [event] = events;
    if (event === undefined) throw new Error("no redirect-refusal line");
    expect(event).toMatchObject({
      op: "update.portable-asset.redirect-refused",
      category: "security",
      level: "warn",
      correlationId: "preflight-redirect-0001",
      errorKind: "unsafe-target",
      extra: {
        assetKind: "manifest",
        reason: "unsafe-target",
        target: "linux-x64",
        completeness: "complete",
        loss: "none",
      },
    });
    const persisted = expectActivityLogProof(
      "update.portable-asset.redirect-refused.reason",
      formatActivityLogProofLine(event),
    );
    expect(persisted).toMatchObject({
      assetKind: "manifest",
      reason: "unsafe-target",
      target: "linux-x64",
    });
  });

  it("classifies every redirect-refusal reason into its registered error kind", () => {
    const cases = [
      ["missing-location", "validation-failed"],
      ["malformed-location", "validation-failed"],
      ["unsafe-target", "unsafe-target"],
      ["unsafe-origin", "unsafe-target"],
      ["loop", "conflict"],
      ["limit", "conflict"],
    ] as const;
    for (const [reason, errorKind] of cases) {
      const { events, sink } = capture();
      recordPortableRedirectRefusal(
        sink,
        "macos-arm64",
        "checksum",
        reason,
        "preflight-redirect-0002",
      );
      expect(events[0]).toMatchObject({ errorKind, extra: { reason } });
    }
  });

  it("degrades to the unknown correlation marker when none is supplied", () => {
    const { events, sink } = capture();
    recordPortableRedirectRefusal(sink, "windows-x64", "manifest", "loop");
    expect(events[0]?.correlationId).toBe("unknown-correlation-id");
  });
});

describe("portable fetch failure activity", () => {
  it("resolves the update.portable-fetch.failed Activity Log proof", () => {
    const { events, sink } = capture();
    recordPortableFetchFailure(
      sink,
      "macos-x64",
      "release-evidence",
      "deadline-exceeded",
      "preflight-fetch-0001",
    );
    const [event] = events;
    if (event === undefined) throw new Error("no fetch-failure line");
    expect(event).toMatchObject({
      op: "update.portable-fetch.failed",
      category: "diagnostic",
      level: "warn",
      correlationId: "preflight-fetch-0001",
      errorKind: "timeout",
      extra: {
        assetKind: "release-evidence",
        reason: "deadline-exceeded",
        target: "macos-x64",
        completeness: "complete",
        loss: "none",
      },
    });
    const persisted = expectActivityLogProof(
      "update.portable-fetch.failed.reason",
      formatActivityLogProofLine(event),
    );
    expect(persisted).toMatchObject({
      assetKind: "release-evidence",
      reason: "deadline-exceeded",
      target: "macos-x64",
    });
  });

  it("classifies every fetch-failure reason into its registered error kind", () => {
    const cases = [
      ["deadline-exceeded", "timeout"],
      ["request-aborted", "cancelled"],
      ["network-unavailable", "unavailable"],
      ["unexpected-failure", "internal"],
    ] as const;
    for (const [reason, errorKind] of cases) {
      const { events, sink } = capture();
      recordPortableFetchFailure(
        sink,
        "linux-x64",
        "release-metadata",
        reason,
        "preflight-fetch-0002",
      );
      expect(events[0]).toMatchObject({ errorKind, extra: { reason } });
    }
  });

  it("does nothing when no sink is wired", () => {
    expect(() => {
      recordPortableFetchFailure(undefined, "linux-x64", "manifest", "network-unavailable");
    }).not.toThrow();
  });
});

describe("release trust verification activity", () => {
  it("resolves the update.release-trust.verify Activity Log proof for a failed verification", () => {
    const { events, sink } = capture();
    recordReleaseTrustFailure(sink, "macos-x64", "signature-invalid", "preflight-trust-0001");
    const [event] = events;
    if (event === undefined) throw new Error("no release-trust line");
    expect(event).toMatchObject({
      op: "update.release-trust.verify",
      category: "security",
      level: "warn",
      correlationId: "preflight-trust-0001",
      errorKind: "validation-failed",
      extra: {
        status: "failed",
        target: "macos-x64",
        reason: "signature-invalid",
        completeness: "complete",
        loss: "none",
      },
    });
    const persisted = expectActivityLogProof(
      "update.release-trust.verify.status",
      formatActivityLogProofLine(event),
    );
    expect(persisted).toMatchObject({
      status: "failed",
      target: "macos-x64",
      reason: "signature-invalid",
    });
  });

  it("resolves the update.release-trust.verify Activity Log proof for a succeeded verification", () => {
    const { events, sink } = capture();
    recordReleaseTrustSuccess(
      sink,
      "macos-x64",
      { keyId: "release-key-2026-09", metadataVersion: 7 },
      "preflight-trust-0002",
    );
    const [event] = events;
    if (event === undefined) throw new Error("no release-trust line");
    expect(event).toMatchObject({
      op: "update.release-trust.verify",
      category: "security",
      correlationId: "preflight-trust-0002",
      extra: {
        status: "succeeded",
        target: "macos-x64",
        keyId: "release-key-2026-09",
        metadataVersion: 7,
        completeness: "complete",
        loss: "none",
      },
    });
    expect(event).not.toHaveProperty("errorKind");
    const persisted = expectActivityLogProof(
      "update.release-trust.verify.status",
      formatActivityLogProofLine(event),
    );
    expect(persisted).toMatchObject({
      status: "succeeded",
      target: "macos-x64",
      keyId: "release-key-2026-09",
      metadataVersion: 7,
    });
  });

  it("accepts every closed release-trust failure reason, always as a validation failure", () => {
    const reasons = [
      "key-untrusted",
      "metadata-expired",
      "metadata-malformed",
      "metadata-rollback",
      "missing",
    ] as const;
    for (const reason of reasons) {
      const { events, sink } = capture();
      recordReleaseTrustFailure(sink, "windows-x64", reason, "preflight-trust-0003");
      expect(events[0]).toMatchObject({
        errorKind: "validation-failed",
        extra: { status: "failed", reason },
      });
    }
  });

  it("does nothing when no sink is wired", () => {
    expect(() => {
      recordReleaseTrustFailure(undefined, "linux-x64", "key-untrusted");
    }).not.toThrow();
    expect(() => {
      recordReleaseTrustSuccess(undefined, "linux-x64", { keyId: "k", metadataVersion: 1 });
    }).not.toThrow();
  });
});
