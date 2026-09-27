import { describe, expect, it } from "vitest";

import {
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { formatActivityLogProofLine } from "../../../../tests/support/activity-log-proof.js";
import { installLayoutOverrideActivityLogEvent } from "../../../keiko-cli/src/install-layout.js";
import {
  processExitingActivityLogEvent,
  processFatalActivityLogEvent,
} from "../../../keiko-cli/src/process-activity-log.js";
import {
  analyzeLogText,
  buildReproductionSeed,
  renderHumanReproductionSeed,
} from "./support-analyze.js";
import {
  activityLogFailureClassesOf,
  projectActivityLogSufficiency,
  restrictActivityLogSufficiency,
  type ActivityLogClassSufficiency,
  type ActivityLogSufficiencyIntegrity,
  type ActivityLogSufficiencyLine,
} from "./support-analyze-sufficiency.js";

const CLEAN: ActivityLogSufficiencyIntegrity = {
  corruptLineCount: 0,
  truncatedLineCount: 0,
  unsupportedLineCount: 0,
  incompleteLineCount: 0,
  sequenceAnomalies: [],
};

const PROCESS = { pid: 4242, instanceId: "0a1b2c3d" } as const;
const OTHER_PROCESS = { pid: 4343, instanceId: "0d0e0f10" } as const;

function line(
  op: string,
  correlationId: string | undefined,
  fields: Readonly<Record<string, unknown>> = {},
  process: { readonly pid: number; readonly instanceId: string } = PROCESS,
): ActivityLogSufficiencyLine {
  return {
    op,
    correlationId,
    ...process,
    fields: { completeness: "complete", loss: "none", ...fields },
  };
}

function classEntry(
  lines: readonly ActivityLogSufficiencyLine[],
  failureClass: string,
  integrity: ActivityLogSufficiencyIntegrity = CLEAN,
): ActivityLogClassSufficiency | undefined {
  return projectActivityLogSufficiency(lines, integrity).classes.find(
    (entry) => entry.failureClass === failureClass,
  );
}

describe("projectActivityLogSufficiency", () => {
  it("is complete when a class's causal start and failure share a correlation", () => {
    const sufficiency = projectActivityLogSufficiency(
      [
        line("gateway.chat.started", "corr-chat-0001"),
        line("gateway.chat.failed", "corr-chat-0001"),
      ],
      CLEAN,
    );
    expect(sufficiency).toEqual({
      status: "complete",
      reasons: [],
      classes: [
        { failureClass: "gateway-chat-call", status: "complete", reasons: [], lineCount: 2 },
      ],
      coverage: {
        observedClassCount: 1,
        completeClassCount: 1,
        degradedClassCount: 0,
        insufficientClassCount: 0,
      },
    });
  });

  it("is insufficient when an end or failure lacks its class's causal start", () => {
    expect(
      classEntry([line("gateway.chat.failed", "corr-chat-0002")], "gateway-chat-call"),
    ).toEqual(
      expect.objectContaining({ status: "insufficient", reasons: ["lifecycle-start-missing"] }),
    );
    expect(
      classEntry(
        [
          line("gateway.chat.started", "corr-chat-0003"),
          line("gateway.chat.completed", "corr-chat-0004"),
        ],
        "gateway-chat-call",
      ),
    ).toEqual(expect.objectContaining({ reasons: ["lifecycle-start-missing"] }));
  });

  it("degrades a causal failure that carries no known correlation", () => {
    expect(
      classEntry(
        [line("gateway.chat.failed", ACTIVITY_LOG_UNKNOWN_CORRELATION_ID)],
        "gateway-chat-call",
      ),
    ).toEqual(expect.objectContaining({ status: "degraded", reasons: ["correlation-unknown"] }));
  });

  it("is insufficient when a parent-correlated operation has no parent", () => {
    const detached = line("indexing.detached-run.launched", "corr-index-0001");
    expect(classEntry([detached], "indexing-detached-run")).toEqual(
      expect.objectContaining({ status: "insufficient", reasons: ["parent-correlation-missing"] }),
    );
    expect(
      classEntry(
        [{ ...detached, parentCorrelationId: "corr-parent-0001" }],
        "indexing-detached-run",
      ),
    ).toEqual(expect.objectContaining({ status: "complete" }));
  });

  it("degrades a class whose own non-loss line declares partial evidence", () => {
    expect(
      classEntry(
        [
          line("gateway.chat.started", "corr-chat-0005"),
          line("gateway.chat.failed", "corr-chat-0005", { completeness: "partial" }),
        ],
        "gateway-chat-call",
      ),
    ).toEqual(expect.objectContaining({ status: "degraded", reasons: ["evidence-partial"] }));
  });

  it("keeps a fully evidenced product loss complete for every class", () => {
    const sufficiency = projectActivityLogSufficiency(
      [
        line("client.diagnostic.rate-limited", "corr-post-0001", {
          loss: "event-dropped",
          trigger: "window",
        }),
        line("request", "corr-post-0001"),
        line("activity-log.loss", undefined, {
          trigger: "exit",
          totalLost: 3,
          clientRateSuppressed: 3,
          completeness: "partial",
          loss: "event-dropped",
        }),
      ],
      CLEAN,
    );
    expect(sufficiency.status).toBe("complete");
    expect(sufficiency.classes.map((entry) => entry.status)).toEqual([
      "complete",
      "complete",
      "complete",
    ]);
  });

  it("degrades every class of the process that reported Activity Log evidence loss", () => {
    const lines = [
      line("gateway.chat.started", "corr-chat-0006"),
      line("gateway.chat.failed", "corr-chat-0006"),
      line("request", "corr-other-0001", {}, OTHER_PROCESS),
      line("activity-log.loss", undefined, {
        trigger: "heartbeat",
        totalLost: 1,
        loggerWriteFailed: 1,
        completeness: "partial",
        loss: "event-dropped",
      }),
    ];
    expect(classEntry(lines, "gateway-chat-call")).toEqual(
      expect.objectContaining({ status: "degraded", reasons: ["activity-log-loss"] }),
    );
    expect(classEntry(lines, "http-request")?.status).toBe("complete");
    expect(classEntry(lines, "activity-log-loss")?.status).toBe("complete");
  });

  it("scopes a port sink failure to its own package's classes in the same process", () => {
    const lines = [
      line("security.vault.key-resolved", "corr-vault-0001"),
      line("gateway.chat.started", "corr-chat-0009"),
      line("gateway.chat.failed", "corr-chat-0009"),
      line("security.log.sink-failed", undefined, {
        droppedOpDigest: "0123456789abcdef",
        failureKind: "Error",
        loss: "event-dropped",
      }),
    ];
    expect(classEntry(lines, "security-vault-key-resolution")).toEqual(
      expect.objectContaining({ status: "degraded", reasons: ["activity-log-loss"] }),
    );
    expect(classEntry(lines, "gateway-chat-call")?.status).toBe("complete");
    expect(classEntry(lines, "activity-log-sink")?.status).toBe("complete");
  });

  it("attributes a dropped line to the classes of the operation it names", () => {
    const lines = [
      line("gateway.chat.started", "corr-chat-0007"),
      line("request", "corr-chat-0007"),
      line("server-log.line-dropped", "corr-chat-0007", {
        failedOp: "gateway.chat.failed",
        droppedLineBytes: 9000,
        completeness: "unknown",
        loss: "event-dropped",
      }),
    ];
    expect(classEntry(lines, "gateway-chat-call")).toEqual(
      expect.objectContaining({ status: "degraded", reasons: ["events-dropped"] }),
    );
    expect(classEntry(lines, "http-request")?.status).toBe("complete");
  });

  it("propagates artifact integrity to every observed class", () => {
    const lines = [line("request", "corr-req-0001")];
    const integrity = (
      overrides: Partial<ActivityLogSufficiencyIntegrity>,
    ): ActivityLogSufficiencyIntegrity => ({
      ...CLEAN,
      ...overrides,
    });
    expect(classEntry(lines, "http-request", integrity({ corruptLineCount: 1 }))?.status).toBe(
      "insufficient",
    );
    expect(
      classEntry(lines, "http-request", integrity({ truncatedLineCount: 1 }))?.reasons,
    ).toEqual(["truncated-evidence"]);
    expect(
      classEntry(lines, "http-request", integrity({ sequenceAnomalies: [{ kind: "gap" }] }))
        ?.status,
    ).toBe("complete");
    expect(
      classEntry(lines, "http-request", integrity({ sequenceAnomalies: [{ kind: "duplicate" }] }))
        ?.reasons,
    ).toEqual(["sequence-anomaly"]);
  });

  it("is insufficient without any registered evidence", () => {
    expect(projectActivityLogSufficiency([line("not.registered", "corr-x-0001")], CLEAN)).toEqual(
      expect.objectContaining({ status: "insufficient", reasons: ["no-registered-evidence"] }),
    );
  });

  it("speaks only the closed contract vocabulary", () => {
    const sufficiency = projectActivityLogSufficiency(
      [
        line("gateway.chat.failed", ACTIVITY_LOG_UNKNOWN_CORRELATION_ID, {
          completeness: "unknown",
        }),
      ],
      { ...CLEAN, truncatedLineCount: 2 },
    );
    for (const reason of sufficiency.reasons) {
      expect(DIAGNOSTIC_SUFFICIENCY_REASONS).toContain(reason);
    }
  });
});

describe("restrictActivityLogSufficiency", () => {
  const all = projectActivityLogSufficiency(
    [line("gateway.chat.failed", "corr-chat-0008"), line("request", "corr-req-0002")],
    CLEAN,
  );

  it("re-summarizes the selected classes only", () => {
    expect(all.status).toBe("insufficient");
    expect(restrictActivityLogSufficiency(all, activityLogFailureClassesOf(["request"]))).toEqual(
      expect.objectContaining({ status: "complete", reasons: [] }),
    );
  });

  it("reports an instrumentation gap when no registered failure class remains", () => {
    expect(restrictActivityLogSufficiency(all, [])).toEqual(
      expect.objectContaining({ status: "insufficient", reasons: ["no-registered-failure"] }),
    );
  });
});

describe("reproduction seed sufficiency", () => {
  it("narrows the artifact's projection to the seed timeline's classes", () => {
    const correlationId = "corr-seed-sufficiency-0001";
    const text = [
      formatActivityLogProofLine(
        installLayoutOverrideActivityLogEvent({
          correlationId,
          overriddenKinds: ["local-state-auditor"],
        }),
      ),
      formatActivityLogProofLine(
        processFatalActivityLogEvent({ kind: "uncaught-exception", failureKind: "TypeError" }),
      ),
    ].join("");
    const seed = buildReproductionSeed(text, correlationId, new Date());
    expect(seed?.sufficiency).toEqual(
      restrictActivityLogSufficiency(
        analyzeLogText(text).sufficiency,
        activityLogFailureClassesOf(["cli.install-layout.normalized"]),
      ),
    );
    expect(seed?.sufficiency.classes.map((entry) => entry.failureClass)).not.toContain(
      "process-fatal",
    );
    expect(renderHumanReproductionSeed(seed ?? fail())).toContain(
      `sufficiency: ${seed?.sufficiency.status ?? ""}`,
    );
  });
});

function fail(): never {
  throw new Error("expected a reproduction seed");
}

describe("analyzeLogText sufficiency", () => {
  it("projects every class the production-persisted lines observed", () => {
    const text = [
      formatActivityLogProofLine(
        processFatalActivityLogEvent({ kind: "uncaught-exception", failureKind: "TypeError" }),
      ),
      formatActivityLogProofLine(
        processExitingActivityLogEvent({ reason: "fatal-exception", uptimeMs: 12 }),
      ),
    ].join("");
    const result = analyzeLogText(text);
    expect(result.sufficiency.status).toBe("complete");
    expect(result.sufficiency.classes.map((entry) => entry.failureClass)).toEqual(
      expect.arrayContaining([
        ...activityLogFailureClassesOf(["process.fatal", "process.exiting"]),
      ]),
    );
    expect(analyzeLogText(`${text}{"torn`).sufficiency).toEqual(
      expect.objectContaining({ status: "degraded", reasons: ["truncated-evidence"] }),
    );
  });
});
