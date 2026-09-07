import { describe, expect, it } from "vitest";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { createBufferedServerLogSink, type ServerLogSink } from "../observability/server-log.js";
import { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";

const NOW = "2026-07-11T12:00:00.000Z";
const LATER = "2026-07-11T12:00:02.000Z";
const SCOPE = {
  remoteDigest: "d".repeat(64),
  pr: { ownerAndRepo: "owner/repository", prNumber: 1 },
  snapshotDigest: "e".repeat(64),
};
const INPUT = {
  scope: SCOPE,
  requestedMode: "governed-assist" as const,
  deploymentCeiling: "autonomous-delivery" as const,
  nowIso: NOW,
};

function service(log?: ServerLogSink): CodingRuntimeAuthorityService {
  return new CodingRuntimeAuthorityService(
    new EditorAgentAuthorityRegistry(),
    undefined,
    undefined,
    undefined,
    undefined,
    log,
  );
}

describe("description authority lifetime and capacity", () => {
  it("never widens or extends a still-live same-scope grant", () => {
    const authority = service();
    const original = authority.mintGitDeliveryDescriptionAuthority({ ...INPUT, ttlMs: 5_000 });
    const reminted = authority.mintGitDeliveryDescriptionAuthority({
      ...INPUT,
      requestedMode: "autonomous-delivery",
      nowIso: LATER,
    });
    expect(reminted).toEqual(original);
    expect(authority.gitDeliveryDescriptionAuthorityPort().current(SCOPE, LATER)).toEqual(original);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 600_001, Number.MAX_VALUE])(
    "rejects invalid TTL %s without retaining a record",
    (ttlMs) => {
      const authority = service();
      expect(() => authority.mintGitDeliveryDescriptionAuthority({ ...INPUT, ttlMs })).toThrow();
      expect(authority.gitDeliveryDescriptionAuthorityPort().current(SCOPE, NOW)).toBeUndefined();
      expect(authority.gitDeliveryDescriptionAuthorityPort().expired?.(SCOPE, NOW)).toBe(false);
    },
  );

  it("rejects an invalid clock before replacing an existing live grant", () => {
    const authority = service();
    const original = authority.mintGitDeliveryDescriptionAuthority(INPUT);
    expect(() =>
      authority.mintGitDeliveryDescriptionAuthority({ ...INPUT, nowIso: "invalid" }),
    ).toThrow();
    expect(authority.gitDeliveryDescriptionAuthorityPort().current(SCOPE, NOW)).toEqual(original);
  });

  it("evicts expired records before live grants at capacity and never exceeds its bound", () => {
    const authority = service();
    authority.mintGitDeliveryDescriptionAuthority(INPUT);
    for (let prNumber = 2; prNumber <= 256; prNumber += 1) {
      authority.mintGitDeliveryDescriptionAuthority({
        ...INPUT,
        scope: { ...SCOPE, pr: { ...SCOPE.pr, prNumber } },
        ttlMs: 1_000,
      });
    }
    authority.mintGitDeliveryDescriptionAuthority({
      ...INPUT,
      scope: { ...SCOPE, pr: { ...SCOPE.pr, prNumber: 257 } },
      nowIso: LATER,
    });
    const port = authority.gitDeliveryDescriptionAuthorityPort();
    expect(port.current(SCOPE, LATER)).toBeDefined();
    expect(port.expired?.({ ...SCOPE, pr: { ...SCOPE.pr, prNumber: 2 } }, LATER)).toBe(false);
    expect(port.expired?.({ ...SCOPE, pr: { ...SCOPE.pr, prNumber: 3 } }, LATER)).toBe(true);
  });
  it("records grants, narrowing and rejection with correlation and no scope bodies", () => {
    const log = createBufferedServerLogSink();
    const authority = service(log);
    const input = { ...INPUT, correlationId: "authority-lifetime-test" };
    authority.mintGitDeliveryDescriptionAuthority(input);
    authority.mintGitDeliveryDescriptionAuthority({
      ...input,
      requestedMode: "autonomous-delivery",
    });
    expect(() =>
      authority.mintGitDeliveryDescriptionAuthority({ ...input, nowIso: "invalid" }),
    ).toThrow();
    expect(log.events).toHaveLength(3);
    expect(log.events.map((event) => event.extra?.event)).toEqual([
      "minted",
      "narrowed",
      "rejected",
    ]);
    for (const event of log.events) {
      expect(event.op).toBe("coding-runtime.description-authority");
      expect(event.correlationId).toBe(input.correlationId);
      expect(event.extra?.scopeDigest).toMatch(/^[a-f\d]{64}$/u);
    }
    expect(log.events[1]?.extra?.effectiveMode).toBe("governed-assist");
    expect(log.events[2]).toMatchObject({
      errorKind: "TypeError",
      extra: { causeChain: [] },
    });
    expect(log.events[2]?.extra?.frames).toBeInstanceOf(Array);
    expect(JSON.stringify(log.events)).not.toContain(SCOPE.pr.ownerAndRepo);
    expect(JSON.stringify(log.events)).not.toContain("invalid");
  });
});
