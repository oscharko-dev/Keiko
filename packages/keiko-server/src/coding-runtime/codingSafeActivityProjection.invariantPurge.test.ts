// #2906 round 3 regression: finalizeIngest's KEIKO-0878 invariant-violation branch (validate
// rejected a post-mutation feed that isFeedNearProjectionLimit's pre-mutation check believed could
// not fail) used to purge with the "expiry" reason -- a code that otherwise means TTL/authority
// expiry (which purges silently via expireCurrent(), with no diagnostic at all) and is completely
// unrelated to a validation/invariant failure. Isolated into its own file because it mocks
// @oscharko-dev/keiko-contracts's validateCodingSafeActivityFeed to force the branch that is, by
// design, unreachable through any legitimate signal (every projection limit is already enforced at
// signal-apply time, so validate never legitimately disagrees with the pre-mutation heuristic) --
// the mock must not leak into the rest of the (real-validator) suite in codingSafeActivityProjection.test.ts.
import { describe, expect, it, vi } from "vitest";

import type { ServerDiagnosticRecord } from "../diagnostics-log.js";

const { validateMock } = vi.hoisted(() => ({
  validateMock: vi.fn(),
}));

vi.mock("@oscharko-dev/keiko-contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-contracts")>();
  return { ...actual, validateCodingSafeActivityFeed: validateMock };
});

const RUN_ID = "run-safe-activity-invariant";
const WORKSPACE_ID = "workspace-safe-activity-invariant";

describe("codingSafeActivityProjection finalizeIngest invariant-violation purge (#2906 round 3)", () => {
  it("purges with a distinct invariant-violation reason, never the unrelated expiry code", async () => {
    // Forces finalizeIngest's post-mutation validate call to fail unconditionally. The freshly
    // opened entry has zero turns, so isFeedNearProjectionLimit's pre-mutation check is false (not
    // near any count-based limit) and no rollback snapshot is taken -- exactly the KEIKO-0878
    // "the threshold heuristic disagreed with validate" scenario this branch defends against.
    validateMock.mockReturnValue({ ok: false, value: undefined, errors: ["forced for test"] });
    const { createCodingSafeActivityProjection } =
      await import("./codingSafeActivityProjection.js");
    const records: ServerDiagnosticRecord[] = [];
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      diagnostics: { record: (record) => void records.push(record) },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });

    const accepted = projection.ingest(RUN_ID, {
      kind: "message",
      messageId: "msg_user_0",
      role: "user",
      occurredAt: "2026-07-18T17:00:00.000Z",
    });

    expect(accepted).toBe(false);
    expect(projection.currentContent()).toBeNull();
    expect(records).toHaveLength(1);
    expect(records[0]?.message).toBe("safe-activity-purged-invariant-violation");
    expect(records[0]?.message).not.toBe("safe-activity-purged-expiry");
    expect(records[0]?.operation).toBe("coding-runtime.safe-activity");
  });
});
