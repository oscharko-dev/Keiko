import { describe, expect, it, vi } from "vitest";
import type {
  UpdateCandidateClaim,
  UpdateInstallMode,
  UpdatePreflightReport,
  UpdateSessionStartRequest,
} from "@oscharko-dev/keiko-contracts";
import { createUpdateCandidateAuthority } from "./update-candidate-authority.js";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function mode(installRoot = "/opt/keiko"): UpdateInstallMode {
  return {
    schemaVersion: "1",
    status: "supported",
    packageName: "@oscharko-dev/keiko",
    installKind: "package-manager",
    packageManager: "npm",
    installRoot,
  };
}

function report(targetVersion = "0.3.18"): UpdatePreflightReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-09-04T12:00:00.000Z",
    currentVersion: "0.3.17",
    targetVersion,
    updateAvailable: true,
    status: "update-available",
    availabilityState: "update-available",
    severity: "normal",
    registryStatus: "ok",
    releaseMetadataStatus: "live",
    installabilitySource: "npm-registry",
    userActionRequired: false,
    affectedStateStores: ["server-runtime"],
    blockers: [],
    manualUpdateRequired: false,
    oneClickEligible: true,
    release: {
      source: "github-release",
      tag: `v${targetVersion}`,
      title: `Keiko ${targetVersion}`,
      summary: "Reviewed update",
      notes: ["Reviewed update"],
    },
    impact: {
      entries: [],
      releaseNoteBullets: [],
      stateImpact: [],
      affectedStateStores: ["server-runtime"],
      userActionRequired: false,
      remediations: [],
    },
    warnings: [],
  };
}

function request(claim: UpdateCandidateClaim): UpdateSessionStartRequest {
  return {
    candidateId: claim.candidateId,
    confirmationDigest: claim.confirmationDigest,
    executionToken: claim.executionToken,
  };
}

function requiredClaim(claim: UpdateCandidateClaim | undefined): UpdateCandidateClaim {
  expect(claim).toBeDefined();
  if (claim === undefined) throw new Error("Expected an update candidate claim.");
  return claim;
}

describe("UpdateCandidateAuthority", () => {
  it("consumes one fresh claim exactly once", () => {
    const authority = createUpdateCandidateAuthority({ now: () => NOW });
    const reviewed = report();
    const claim = requiredClaim(authority.issue(reviewed, mode()));
    const input = request(claim);

    expect(authority.consume(input, "0.3.17", mode(), reviewed)).toMatchObject({
      ok: true,
      snapshot: { targetVersion: "0.3.18" },
    });
    expect(authority.consume(input, "0.3.17", mode(), reviewed)).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  it("does not burn a live claim for invalid token or digest credentials", () => {
    const authority = createUpdateCandidateAuthority({ now: () => NOW });
    const reviewed = report();
    const tokenClaim = requiredClaim(authority.issue(reviewed, mode()));
    expect(
      authority.consume(
        { ...request(tokenClaim), executionToken: "f".repeat(64) },
        "0.3.17",
        mode(),
        reviewed,
      ),
    ).toEqual({ ok: false, reason: "claim-mismatch" });
    expect(authority.consume(request(tokenClaim), "0.3.17", mode(), reviewed)).toMatchObject({
      ok: true,
    });

    const digestClaim = requiredClaim(authority.issue(reviewed, mode()));
    expect(
      authority.consume(
        { ...request(digestClaim), confirmationDigest: "e".repeat(64) },
        "0.3.17",
        mode(),
        reviewed,
      ),
    ).toEqual({ ok: false, reason: "claim-mismatch" });
    expect(authority.consume(request(digestClaim), "0.3.17", mode(), reviewed)).toMatchObject({
      ok: true,
    });
  });

  it("does not evict valid claims for unknown consumes or ineligible issues at capacity", () => {
    const authority = createUpdateCandidateAuthority({ now: () => NOW, capacity: 32 });
    const reviewed = report();
    const claims = Array.from({ length: 32 }, () =>
      requiredClaim(authority.issue(reviewed, mode())),
    );
    expect(
      authority.consume(
        {
          candidateId: "unknown-candidate",
          confirmationDigest: "d".repeat(64),
          executionToken: "e".repeat(64),
        },
        "0.3.17",
        mode(),
        reviewed,
      ),
    ).toEqual({ ok: false, reason: "unknown" });
    expect(authority.issue({ ...reviewed, oneClickEligible: false }, mode())).toBeUndefined();
    expect(
      authority.consume(request(requiredClaim(claims[0])), "0.3.17", mode(), reviewed),
    ).toMatchObject({
      ok: true,
    });
  });

  it("caps only successful claim and tombstone insertions", () => {
    const reviewed = report();
    const issuedAuthority = createUpdateCandidateAuthority({ now: () => NOW, capacity: 32 });
    const issued = Array.from({ length: 33 }, () =>
      requiredClaim(issuedAuthority.issue(reviewed, mode())),
    );
    expect(
      issuedAuthority.consume(request(requiredClaim(issued[0])), "0.3.17", mode(), reviewed),
    ).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(
      issuedAuthority.consume(request(requiredClaim(issued.at(-1))), "0.3.17", mode(), reviewed),
    ).toMatchObject({ ok: true });

    const consumedAuthority = createUpdateCandidateAuthority({ now: () => NOW, capacity: 32 });
    const consumed = Array.from({ length: 33 }, () => {
      const claim = requiredClaim(consumedAuthority.issue(reviewed, mode()));
      expect(consumedAuthority.consume(request(claim), "0.3.17", mode(), reviewed)).toMatchObject({
        ok: true,
      });
      return claim;
    });
    expect(
      consumedAuthority.consume(request(requiredClaim(consumed[0])), "0.3.17", mode(), reviewed),
    ).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(
      consumedAuthority.consume(
        request(requiredClaim(consumed.at(-1))),
        "0.3.17",
        mode(),
        reviewed,
      ),
    ).toEqual({ ok: false, reason: "replayed" });
  });

  it("rejects expiry before returning execution facts", () => {
    let now = NOW;
    const authority = createUpdateCandidateAuthority({ now: () => now, ttlMs: 10 });
    const reviewed = report();
    const claim = requiredClaim(authority.issue(reviewed, mode()));
    now += 11;

    expect(authority.consume(request(claim), "0.3.17", mode(), reviewed)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects changed current version, install facts, or producer output", () => {
    const authority = createUpdateCandidateAuthority({ now: () => NOW });
    const reviewed = report();
    const currentChanged = requiredClaim(authority.issue(reviewed, mode()));
    const installChanged = requiredClaim(authority.issue(reviewed, mode()));
    const producerChanged = requiredClaim(authority.issue(reviewed, mode()));

    expect(authority.consume(request(currentChanged), "0.3.18", mode(), reviewed)).toMatchObject({
      ok: false,
      reason: "current-version-changed",
    });
    expect(
      authority.consume(request(installChanged), "0.3.17", mode("/opt/rebound"), reviewed),
    ).toMatchObject({ ok: false, reason: "install-facts-changed" });
    expect(
      authority.consume(request(producerChanged), "0.3.17", mode(), report("0.3.19")),
    ).toMatchObject({ ok: false, reason: "claim-mismatch" });
  });

  it("does not issue an execution claim for a blocked report", () => {
    const authority = createUpdateCandidateAuthority({ now: () => NOW });
    expect(
      authority.issue(
        {
          ...report(),
          oneClickEligible: false,
          blockers: [
            {
              code: "manual-review-required",
              message: "Manual review required.",
              severity: "normal",
              userActionRequired: true,
            },
          ],
        },
        mode(),
      ),
    ).toBeUndefined();
  });

  it("emits only body-free candidate identity and never the execution token", () => {
    const events: unknown[] = [];
    const authority = createUpdateCandidateAuthority({
      now: () => NOW,
      idFactory: () => "candidate-3405-0123456789abcdef",
      tokenFactory: () => "a".repeat(64),
      activityLog: { write: (event): void => void events.push(event) },
    });
    const reviewed = report();
    const claim = requiredClaim(authority.issue(reviewed, mode()));

    authority.consume(
      { ...request(claim), requestId: "request-3405-0123456789abcdef" },
      "0.3.17",
      mode(),
      reviewed,
    );

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(claim.executionToken);
    expect(serialized).not.toContain("Reviewed update");
    expect(serialized).not.toContain("releaseNoteBullets");
    expect(events).toHaveLength(2);
  });

  it("reports a canonical activity sink failure through bounded diagnostics", () => {
    const record = vi.fn();
    const authority = createUpdateCandidateAuthority({
      now: () => NOW,
      activityLog: {
        write(): void {
          throw new Error("activity unavailable");
        },
      },
      diagnostics: { record },
    });

    expect(authority.issue(report(), mode())).toBeDefined();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "update.candidate.activity-log",
        source: "update-candidate-authority",
      }),
    );
  });
});
