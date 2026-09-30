// Field report 1.1.13: the Knowledge Pod answer prompt ignored the answering model's window, so a
// small deployment refused every grounded question and a provider-reported window left nothing to
// re-plan. These pin the fitting rule: keep the highest-ranked references that fit, refuse locally
// when not even one fits, and leave body-free evidence of both.
import { afterEach, describe, expect, it } from "vitest";
import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { fitKnowledgePrompt } from "./knowledge-prompt-window.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";

afterEach(() => {
  resetServerLogger();
});

const EXCERPT = "Die Kontoeröffnung setzt eine erfolgreiche Legitimationsprüfung voraus. ".repeat(
  20,
);

function render(count: number): {
  readonly messages: readonly { readonly role: "system" | "user"; readonly content: string }[];
} {
  const citations = Array.from(
    { length: count },
    (_, index) => `[${String(index + 1)}] ${EXCERPT}`,
  );
  return {
    messages: [
      { role: "system", content: "Answer from the citations." },
      { role: "user", content: ["Question: Welche Kontoarten?", ...citations].join("\n") },
    ],
  };
}

function profile(maxInputTokens: number): ReturnType<typeof deriveContextProfile> {
  return deriveContextProfile({
    maxInputTokens,
    reservedOutputTokens: 512,
    safetyMarginTokens: 64,
  });
}

function capture(): ReturnType<typeof createBufferedServerLogSink> {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  return sink;
}

describe("fitKnowledgePrompt", () => {
  it("sends every reference when the prompt fits and records nothing", () => {
    const sink = capture();
    const fitted = fitKnowledgePrompt(16, render, profile(128_000), "corr-fits");
    expect(fitted.referenceCount).toBe(16);
    expect(sink.events).toHaveLength(0);
  });

  it("keeps the highest-ranked references that fit a small window", () => {
    const sink = capture();
    const fitted = fitKnowledgePrompt(16, render, profile(3_072), "corr-trim");
    expect(fitted.referenceCount).toBeGreaterThan(0);
    expect(fitted.referenceCount).toBeLessThan(16);
    expect(fitted.prompt).toEqual(render(fitted.referenceCount));
    const line = formatActivityLogProofLine(sink.events[0] ?? {});
    const record = expectActivityLogProof("search.prompt.window-fitted.line", line);
    expect(record).toMatchObject({
      correlationId: "corr-trim",
      state: "trimmed",
      referenceCount: 16,
      sentReferenceCount: fitted.referenceCount,
    });
  });

  it("refuses locally when not even one reference fits", () => {
    const sink = capture();
    expect(() => fitKnowledgePrompt(16, render, profile(900), "corr-refused")).toThrow(
      ContextOverflowError,
    );
    expect(sink.events[0]).toMatchObject({
      op: "search.prompt.window-fitted",
      errorKind: "invalid-request",
      extra: { state: "refused", sentReferenceCount: 0 },
    });
  });

  it("sends the full prompt when no profile is known", () => {
    expect(fitKnowledgePrompt(4, render, undefined, undefined).referenceCount).toBe(4);
  });
});
