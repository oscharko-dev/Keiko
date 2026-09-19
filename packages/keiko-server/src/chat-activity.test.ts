// Registry-linked executable proofs (#3532) for every Activity Log operation `chat-activity.ts`
// emits. There is no pre-existing co-located test file for this module (one is created here,
// following the repository's `foo.ts` -> `foo.test.ts` convention) — every proof drives the real
// exported emitter function with either the real process logger (captured via a buffered sink) or
// the module's own explicit-sink parameter, then reads back the production-computed event through
// `formatActivityLogProofLine` (this task's rule 1: no hand-built event or registration object).

import { afterEach, describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  logChatCreationRejectionEvent,
  logChatRejectionEvent,
  logChatTurnStartedEvent,
  logGitChangeApply,
  logGitChangeDescriptionTargetDenied,
  logGitChangeTurnAuthorityEvent,
} from "./chat-activity.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";

function captureServerLog(): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  return sink;
}

afterEach(() => {
  resetServerLogger();
});

describe("chat-activity.ts Activity Log proofs (#3532)", () => {
  it("chat.creation.rejected — persists the readiness rejection reason and model kind", () => {
    const sink = captureServerLog();

    logChatCreationRejectionEvent({
      correlationId: "corr-chat-create-rejected-01",
      status: 503,
      reason: "readiness",
      modelKind: "chat",
    });

    const [event] = sink.events;
    const line = formatActivityLogProofLine(event ?? {});
    const persisted = expectActivityLogProof("chat.creation.rejected.reason", line);
    expect(persisted).toMatchObject({
      category: "gateway",
      correlationId: "corr-chat-create-rejected-01",
      status: 503,
      errorKind: "unavailable",
      reason: "readiness",
      modelKind: "chat",
      completeness: "complete",
      loss: "none",
    });
  });

  it("chat.send.rejected — persists the grounding-scope rejection reason", () => {
    const sink = captureServerLog();

    logChatRejectionEvent("chat.send.rejected", {
      correlationId: "corr-chat-send-rejected-01",
      status: 400,
      reason: "grounding-scope",
      modelKind: "chat",
    });

    const [event] = sink.events;
    const line = formatActivityLogProofLine(event ?? {});
    const persisted = expectActivityLogProof("chat.send.rejected.reason", line);
    expect(persisted).toMatchObject({
      category: "gateway",
      correlationId: "corr-chat-send-rejected-01",
      status: 400,
      errorKind: "invalid-request",
      reason: "grounding-scope",
      modelKind: "chat",
    });
  });

  it("chat.regeneration.rejected — persists the generation-failure rejection reason", () => {
    const sink = captureServerLog();

    logChatRejectionEvent("chat.regeneration.rejected", {
      correlationId: "corr-chat-regen-rejected-01",
      status: 502,
      reason: "generation",
      modelKind: "unknown",
    });

    const [event] = sink.events;
    const line = formatActivityLogProofLine(event ?? {});
    const persisted = expectActivityLogProof("chat.regeneration.rejected.reason", line);
    expect(persisted).toMatchObject({
      category: "gateway",
      correlationId: "corr-chat-regen-rejected-01",
      status: 502,
      errorKind: "internal",
      reason: "generation",
      modelKind: "unknown",
    });
  });

  it("chat.turn.started — persists the per-role message shape counts", () => {
    const sink = captureServerLog();

    logChatTurnStartedEvent("corr-chat-turn-started-01", {
      messageCount: 5,
      systemCount: 1,
      userCount: 2,
      assistantCount: 2,
      toolCount: 0,
      imageAttachmentCount: 1,
      imageAttachmentBytes: 2_048,
    });

    const [event] = sink.events;
    const line = formatActivityLogProofLine(event ?? {});
    const persisted = expectActivityLogProof("chat.turn.started.shape", line);
    expect(persisted).toMatchObject({
      category: "gateway",
      correlationId: "corr-chat-turn-started-01",
      messageCount: 5,
      systemCount: 1,
      userCount: 2,
      assistantCount: 2,
      toolCount: 0,
      imageAttachmentCount: 1,
      imageAttachmentBytes: 2_048,
    });
  });

  it("pr-description.chat.turn.admitted — persists the relationship id on admission", () => {
    const sink = captureServerLog();

    logGitChangeTurnAuthorityEvent(
      "corr-pr-turn-admitted-01",
      { admitted: true },
      "relationship-abc-123",
    );

    const [event] = sink.events;
    const line = formatActivityLogProofLine(event ?? {});
    const persisted = expectActivityLogProof(
      "pr-description.chat.turn.admitted.relationship",
      line,
    );
    expect(persisted).toMatchObject({
      category: "security",
      correlationId: "corr-pr-turn-admitted-01",
      relationshipId: "relationship-abc-123",
      completeness: "complete",
      loss: "none",
    });
  });

  it("pr-description.chat.turn.denied — persists the denial reason on an expired authority", () => {
    const sink = captureServerLog();

    logGitChangeTurnAuthorityEvent(
      "corr-pr-turn-denied-01",
      { admitted: false, reason: "authority-expired" },
      "relationship-def-456",
    );

    const [event] = sink.events;
    const line = formatActivityLogProofLine(event ?? {});
    const persisted = expectActivityLogProof("pr-description.chat.turn.denied.reason", line);
    expect(persisted).toMatchObject({
      category: "security",
      correlationId: "corr-pr-turn-denied-01",
      relationshipId: "relationship-def-456",
      reason: "authority-expired",
      errorKind: "validation-failed",
    });
  });

  it("git-change.chat.description-target.denied — persists the reader-unauthorized denial", () => {
    const sink = createBufferedServerLogSink();

    logGitChangeDescriptionTargetDenied(sink, "corr-target-denied-01", "reader-unauthorized");

    const [event] = sink.events;
    const line = formatActivityLogProofLine(event ?? {});
    const persisted = expectActivityLogProof(
      "git-change.chat.description-target.denied.reason",
      line,
    );
    expect(persisted).toMatchObject({
      category: "security",
      correlationId: "corr-target-denied-01",
      reason: "reader-unauthorized",
      errorKind: "authority-denied",
    });
  });

  it("git-change.chat.apply — persists the preview outcome", () => {
    const sink = createBufferedServerLogSink();

    logGitChangeApply(sink, "corr-git-apply-01", "preview");

    const [event] = sink.events;
    const line = formatActivityLogProofLine(event ?? {});
    const persisted = expectActivityLogProof("git-change.chat.apply.outcome", line);
    expect(persisted).toMatchObject({
      category: "process",
      correlationId: "corr-git-apply-01",
      outcome: "preview",
      completeness: "complete",
      loss: "none",
    });
  });
});

// #3557: a readiness refusal names the refused model and the state that refused it, so a refusal
// without any check in this process is never mistaken for a failed live check.
describe("chat rejection readiness evidence (#3557)", () => {
  it.each(["unobserved", "not-ready"] as const)(
    "chat.regeneration.rejected — persists the %s readiness observation with the model digest",
    (readinessObservation) => {
      const sink = captureServerLog();

      logChatRejectionEvent("chat.regeneration.rejected", {
        correlationId: "corr-chat-regen-readiness-01",
        status: 400,
        reason: "readiness",
        modelKind: "chat",
        modelIdDigest: "0123456789abcdef",
        readinessObservation,
      });

      const [event] = sink.events;
      const persisted = expectActivityLogProof(
        "chat.regeneration.rejected.reason",
        formatActivityLogProofLine(event ?? {}),
      );
      expect(persisted).toMatchObject({
        correlationId: "corr-chat-regen-readiness-01",
        errorKind: "unavailable",
        reason: "readiness",
        modelIdDigest: "0123456789abcdef",
        readinessObservation,
      });
    },
  );

  // #3557 review: a model id is operator-chosen text that no check proves body-free, so a rejection
  // carries it only as a digest. `model-id-evidence.test.ts` proves the projection; this proves
  // chat-activity.ts emits what it is handed and never a raw id.
  it("chat.creation.rejected — persists the model only as its digest", () => {
    const sink = captureServerLog();

    logChatCreationRejectionEvent({
      correlationId: "corr-chat-create-model-digest",
      status: 400,
      reason: "configuration",
      modelKind: "unknown",
      modelIdDigest: "0123456789abcdef",
    });

    const [event] = sink.events;
    const persisted = expectActivityLogProof(
      "chat.creation.rejected.reason",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(persisted).toMatchObject({ modelIdDigest: "0123456789abcdef" });
    expect(persisted).not.toHaveProperty("modelId");
  });

  it("chat.creation.rejected — bounds an overlong modelIdDigest to the operation's 16 characters", () => {
    const sink = captureServerLog();

    logChatCreationRejectionEvent({
      correlationId: "corr-chat-create-digest-long",
      status: 400,
      reason: "configuration",
      modelKind: "unknown",
      modelIdDigest: "a".repeat(30),
    });

    const [event] = sink.events;
    expect(event?.extra?.modelIdDigest).toBe("a".repeat(16));
  });
});
