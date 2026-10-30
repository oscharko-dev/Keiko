// The review diff package through the composed review services (Issue #4134): the hardened runner
// is the observed production runner, and its evidence stays body-free (no path, no content).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { captureActivityLog } from "../../activityLogCapture.test-support.js";
import { createReviewServices } from "../services.js";
import { DiffFixtureRepository } from "./diffFixtures.test-support.js";
import { numbered } from "./diffPackageAssertions.test-support.js";

let fixture: DiffFixtureRepository;

beforeEach(() => {
  fixture = new DiffFixtureRepository("keiko-review-diff-services-");
});

afterEach(() => {
  fixture.cleanup();
});

const SECRET_NAME = "customer-secret-name.ts";

function services(listingMaxBytes?: number): {
  readonly log: ReturnType<typeof captureActivityLog>;
  readonly built: ReturnType<typeof createReviewServices>;
} {
  const log = captureActivityLog();
  const built = createReviewServices({
    reviewRoot: join(fixture.root, "state", "review-worktrees"),
    activityLog: log.sink,
    github: {
      ownerAndRepo: () => Promise.resolve(undefined),
      readerFor: () => {
        throw new Error("unused");
      },
    },
    ...(listingMaxBytes === undefined ? {} : { diffPackageLimits: { listingMaxBytes } }),
  });
  return { log, built };
}

describe("ReviewServices.buildDiffPackage", () => {
  it("builds the package with the observed hardened runner", async () => {
    const base = fixture.commit([{ path: SECRET_NAME, content: numbered(20) }]);
    const head = fixture.commit([{ path: SECRET_NAME, content: numbered(21) }]);
    const { built } = services();
    const result = await built.buildDiffPackage({
      repositoryRoot: fixture.repo,
      baseSha: base,
      headSha: head,
      config: { budgetTokens: 10_000 },
      correlationId: "corr-diff-1",
    });
    expect(result.ok && result.package.coverage.included.map((file) => file.path)).toEqual([
      SECRET_NAME,
    ]);
    await built.dispose();
  });

  it("records a failing Git step body-free and fails the package closed", async () => {
    const base = fixture.commit([{ path: SECRET_NAME, content: numbered(20) }]);
    const head = fixture.commit([{ path: SECRET_NAME, content: numbered(21) }]);
    const { built, log } = services(16);
    const result = await built.buildDiffPackage({
      repositoryRoot: fixture.repo,
      baseSha: base,
      headSha: head,
      config: { budgetTokens: 10_000 },
      correlationId: "corr-diff-2",
    });
    expect(result).toEqual({
      ok: false,
      failure: { reason: "diff-too-large", detail: "listing-bytes" },
    });
    const failed = log.withOp("git.process.failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.correlationId).toBe("corr-diff-2");
    expect(JSON.stringify(log.events)).not.toContain("customer-secret");
    await built.dispose();
  });
});
