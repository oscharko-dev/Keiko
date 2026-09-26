import type { VerificationDependencySummary } from "@oscharko-dev/keiko-contracts";
import { VERIFICATION_DEPENDENCY_FAILURE_STATES } from "@oscharko-dev/keiko-contracts/runtime/verification";
import { VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/verification";
import { describe, expect, it, vi } from "vitest";

import { createCodingToolFacade } from "./codingToolFacade.js";
import type { CodingToolAuthorityPort, CodingToolDelegatePort } from "./codingToolFacadePorts.js";
import { dependencyBootstrapFailureSummary } from "./codingToolIpc.js";

// PR #3452 (found by the test pass): a failed dependency bootstrap's summary carried free-text
// detail that the facade's closed admission refused, so the facade dropped the whole
// verificationFailure (reason, excerpt and dependency record) before it reached the model. The
// summary now has one owner, and the facade admits it only beside a dependency record that names the
// same failure state; a step failure is admitted only without one.

const capability = "capability-1-opaque-runtime-secret";
const FAILED = {
  status: "failed",
  reasonCode: "VERIFICATION_FAILED",
  evidence: [{ kind: "governed-delegate", code: "VERIFICATION_FAILED" }],
} as const;

interface FacadePorts {
  authority: { admit: CodingToolAuthorityPort["admit"] };
  delegate: { execute: CodingToolDelegatePort["execute"] };
}

function dependencyRecord(
  state: VerificationDependencySummary["state"],
): VerificationDependencySummary {
  return {
    state,
    lockfile: "absent",
    exitCode: state === "failed" ? 1 : null,
    durationMs: 1_200,
    detail: "npm install failed (exit 1)",
  };
}

function portsFailingWith(verificationFailure: unknown): FacadePorts {
  return {
    authority: {
      admit: vi.fn(() => ({ ok: true as const, mutationGuard: { check: (): true => true } })),
    },
    delegate: {
      execute: vi.fn(() =>
        Promise.resolve({
          outcome: "failed",
          reasonCode: "VERIFICATION_FAILED",
          verificationFailure,
        }),
      ),
    },
  };
}

function executeWith(verificationFailure: unknown): Promise<unknown> {
  return createCodingToolFacade(portsFailingWith(verificationFailure)).execute({
    body: JSON.stringify({
      actionId: "action-1",
      idempotencyKey: "idempotency-1", // gitleaks:allow — test fixture, not a real key
      action: "verification",
      verifierId: "test",
    }),
    capability,
  });
}

describe("dependency bootstrap failures through the facade", () => {
  it.each([...VERIFICATION_DEPENDENCY_FAILURE_STATES])(
    "forwards a %s bootstrap with its summary, excerpt and dependency record",
    async (state) => {
      const failure = {
        summary: dependencyBootstrapFailureSummary(state),
        locations: [],
        truncated: false,
        excerpt: "npm ERR! code E404",
        dependencies: dependencyRecord(state),
      };

      await expect(executeWith(failure)).resolves.toEqual({
        ...FAILED,
        verificationFailure: failure,
      });
    },
  );

  // The guard the facade applies to a forwarded excerpt (validVerificationFailureExcerpt in
  // codingToolFacade.ts) accepts 1..VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS characters unmodified,
  // plus exactly one character more: outputExcerpt (keiko-verification/src/excerpt.ts) truncates by
  // prefixing a single ellipsis character to a MAX_CHARS-length tail, so a truncated excerpt is
  // always exactly MAX_CHARS + 1 long ("bounded by the same cap it was cut to"). That is the true
  // accepted maximum, not an off-by-one.
  it("forwards a failure whose excerpt is exactly the longest length outputExcerpt ever produces", async () => {
    const failure = {
      summary: dependencyBootstrapFailureSummary("failed"),
      locations: [],
      truncated: false,
      excerpt: "e".repeat(VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS + 1),
      dependencies: dependencyRecord("failed"),
    };

    await expect(executeWith(failure)).resolves.toEqual({
      ...FAILED,
      verificationFailure: failure,
    });
  });

  it.each([
    {
      name: "the summary names another state than its record",
      failure: {
        summary: dependencyBootstrapFailureSummary("failed"),
        locations: [],
        truncated: false,
        dependencies: dependencyRecord("timed-out"),
      },
    },
    {
      name: "a bootstrap summary arrives without its record",
      failure: {
        summary: dependencyBootstrapFailureSummary("failed"),
        locations: [],
        truncated: false,
      },
    },
    {
      name: "a step failure carries a dependency record",
      failure: {
        summary: "build failed; 0 structured failure locations",
        locations: [],
        truncated: false,
        dependencies: dependencyRecord("failed"),
      },
    },
    {
      name: "the record is not a failure state",
      failure: {
        summary: dependencyBootstrapFailureSummary("installed"),
        locations: [],
        truncated: false,
        dependencies: dependencyRecord("installed"),
      },
    },
    {
      name: "the summary carries free text, the shape the producer used to send",
      failure: {
        summary:
          "dependency installation failed: npm install failed (exit 1); no verification step ran",
        locations: [],
        truncated: false,
        dependencies: dependencyRecord("failed"),
      },
    },
    {
      name: "the excerpt is empty",
      failure: {
        summary: dependencyBootstrapFailureSummary("failed"),
        locations: [],
        truncated: false,
        excerpt: "",
        dependencies: dependencyRecord("failed"),
      },
    },
    {
      name: "the excerpt is one character past the longest length outputExcerpt ever produces",
      failure: {
        summary: dependencyBootstrapFailureSummary("failed"),
        locations: [],
        truncated: false,
        excerpt: "e".repeat(VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS + 2),
        dependencies: dependencyRecord("failed"),
      },
    },
  ])("drops the failure when $name", async ({ failure }) => {
    await expect(executeWith(failure)).resolves.toEqual(FAILED);
  });
});
