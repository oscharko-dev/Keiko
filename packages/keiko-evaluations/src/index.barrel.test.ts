// KEIKO-0313 regression pin — the evaluations SDK barrel must surface every eval suite as a
// namespace so a CLI or embedding consumer can invoke it via the public package entry. The Voice
// Action Governance suite was previously reachable only through its private sub-barrel; the audit
// KEIKO-0313 confirmed the omission left ~1000 lines of security-gating scorer/runner/fixtures
// unreachable through the SDK. This test pins the addition (and the sibling suites' presence, so a
// future removal is caught too).

import { describe, expect, it } from "vitest";
import * as pkg from "./index.js";

describe("KEIKO-0313 evaluations barrel exposes every eval suite as a namespace", () => {
  it.each([
    { name: "LocalKnowledgeEval" },
    { name: "PromptEnhancerEval" },
    { name: "DiscussionEval" },
    { name: "VoiceTwinEval" },
    { name: "VoiceAcousticEval" },
    { name: "VoiceActionEval" },
  ])("$name namespace is defined on the barrel", ({ name }) => {
    const value = (pkg as unknown as Record<string, unknown>)[name];
    expect(value, `expected ${name} on package barrel`).toBeDefined();
    expect(typeof value).toBe("object");
    expect(value).not.toBeNull();
  });

  it("VoiceActionEval namespace exposes the security-gating scorer + runner as callable functions", () => {
    // The two load-bearing functions the Voice Action suite exists to provide. If either becomes
    // undefined, the audit-KEIKO-0313 gap re-opens because the public consumer path is broken.
    const namespace = (pkg as unknown as Record<string, Record<string, unknown> | undefined>)
      .VoiceActionEval;
    expect(namespace).toBeDefined();
    if (namespace === undefined) return;
    expect(typeof namespace.runVoiceActionEvaluation).toBe("function");
    expect(typeof namespace.scoreVoiceActionQuality).toBe("function");
    expect(typeof namespace.deriveVoiceActionObservation).toBe("function");
    // Fixture registry constant is present too — the runner needs it and consumers walk it.
    expect(Array.isArray(namespace.ALL_VOICE_ACTION_FIXTURES)).toBe(true);
  });
});
