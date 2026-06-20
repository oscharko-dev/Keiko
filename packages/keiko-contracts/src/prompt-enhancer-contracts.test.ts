// Contract-stability and model-agnosticism tests for the Prompt Enhancer surface (Issue #1309 AC5,
// Expected Verification "Contract tests prove JSON/wire shapes are stable and do not expose secrets
// or provider config"). These assert the closed taxonomies are well-formed, the profile catalog is
// consistent, the wire shapes survive JSON round-trips, and no contract field name leaks a
// credential, provider endpoint, hidden system prompt, or tool-authority grant.

import { describe, it, expect } from "vitest";
import {
  analyzePrompt,
  assertNeverTaskClass,
  asEnhancedPromptId,
  asPromptEnhancementRequestId,
  normalizePromptDraft,
  PROMPT_ANALYSIS_MAX_SCAN_CHARS,
  validatePromptEnhancerIdString,
  GROUNDING_NEED_KINDS,
  MISSING_CONTEXT_TOPICS,
  MISSING_INFORMATION_STRATEGIES,
  OUTPUT_FORMAT_HINTS,
  PROMPT_CRITICALITIES,
  PROMPT_DOMAINS,
  PROMPT_ENHANCEMENT_PROFILE_IDS,
  PROMPT_ENHANCEMENT_PROFILES,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  PROMPT_OUTPUT_FORMATS,
  PROMPT_RISK_CLASSES,
  PROMPT_SIGNAL_DIMENSIONS,
  PROMPT_SIGNAL_STRENGTHS,
  PROMPT_TASK_CLASSES,
  SAFETY_CRITICAL_DOMAINS,
  type EnhancedPrompt,
  type PromptEnhancementProfileId,
  type PromptEnhancementRequest,
} from "./index.js";

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key.toLowerCase());
      collectKeys(child, into);
    }
  }
}

const FORBIDDEN_KEY_SUBSTRINGS: readonly string[] = [
  "apikey",
  "secret",
  "password",
  "credential",
  "bearer",
  "baseurl",
  "endpoint",
  "providerconfig",
  "systemprompt",
  "hiddenprompt",
  "authorization",
  "privatekey",
  "accesskey",
  "toolauthority",
  "grantedtools",
  "allowedtools",
  "canexecute",
];

const sampleRequest: PromptEnhancementRequest = {
  schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
  requestId: asPromptEnhancementRequestId("req-xyz"),
  input: { text: "Research the trade-offs of event sourcing.", hasConnectedContext: false },
  missingInformationStrategy: "assume",
  profilePreference: "research",
};

const sampleEnhancedPrompt: EnhancedPrompt = {
  schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
  promptId: asEnhancedPromptId("ep-9"),
  role: "Analyst",
  goal: "Compare the approaches.",
  context: ["User is choosing a persistence strategy."],
  input: "Research the trade-offs of event sourcing.",
  taskDecomposition: ["Define criteria", "Compare", "Recommend"],
  constraints: ["Neutral tone"],
  groundingRules: ["Cite supplied sources only"],
  outputSchema: { format: "markdown", structured: false, hints: ["explicit-markdown"] },
  qualityCriteria: ["Balanced", "Evidence-based"],
  uncertaintyHandling: ["Flag gaps as assumptions"],
  safetyRules: ["No authority grants"],
};

// ─── AC5: model-agnostic, no leaked authority ────────────────────────────────────
describe("prompt enhancer contracts are model-agnostic (AC5)", () => {
  const samples: readonly { readonly label: string; readonly value: unknown }[] = [
    { label: "request", value: sampleRequest },
    { label: "analysis", value: analyzePrompt(sampleRequest) },
    { label: "enhanced prompt", value: sampleEnhancedPrompt },
    { label: "profile catalog", value: PROMPT_ENHANCEMENT_PROFILES },
  ];

  it.each(samples)("$label carries no credential, provider, or authority field", ({ value }) => {
    const keys = new Set<string>();
    collectKeys(value, keys);
    for (const forbidden of FORBIDDEN_KEY_SUBSTRINGS) {
      const offending = [...keys].filter((key) => key.includes(forbidden));
      expect(offending, `forbidden key substring "${forbidden}"`).toEqual([]);
    }
  });

  it("an enhanced prompt cannot encode tool, secret, or egress authority as a field", () => {
    const keys = new Set<string>();
    collectKeys(sampleEnhancedPrompt, keys);
    expect([...keys].sort()).toEqual(
      [
        "constraints",
        "context",
        "format",
        "goal",
        "groundingrules",
        "hints",
        "input",
        "outputschema",
        "promptid",
        "qualitycriteria",
        "role",
        "safetyrules",
        "schemaversion",
        "structured",
        "taskdecomposition",
        "uncertaintyhandling",
      ].sort(),
    );
  });
});

// ─── Closed-set integrity ────────────────────────────────────────────────────────
describe("prompt enhancer closed taxonomies", () => {
  const tables: readonly { readonly label: string; readonly table: readonly string[] }[] = [
    { label: "task classes", table: PROMPT_TASK_CLASSES },
    { label: "domains", table: PROMPT_DOMAINS },
    { label: "criticalities", table: PROMPT_CRITICALITIES },
    { label: "risk classes", table: PROMPT_RISK_CLASSES },
    { label: "grounding kinds", table: GROUNDING_NEED_KINDS },
    { label: "output formats", table: PROMPT_OUTPUT_FORMATS },
    { label: "output hints", table: OUTPUT_FORMAT_HINTS },
    { label: "missing-context topics", table: MISSING_CONTEXT_TOPICS },
    { label: "missing-info strategies", table: MISSING_INFORMATION_STRATEGIES },
    { label: "signal strengths", table: PROMPT_SIGNAL_STRENGTHS },
    { label: "signal dimensions", table: PROMPT_SIGNAL_DIMENSIONS },
    { label: "profile ids", table: PROMPT_ENHANCEMENT_PROFILE_IDS },
  ];

  it.each(tables)("$label has no duplicate members", ({ table }) => {
    expect(new Set(table).size).toBe(table.length);
  });

  it("covers at least ten task classes", () => {
    expect(PROMPT_TASK_CLASSES.length).toBeGreaterThanOrEqual(10);
  });

  it("treats the four consequential domains as safety-critical", () => {
    expect([...SAFETY_CRITICAL_DOMAINS].sort()).toEqual([
      "finance",
      "legal",
      "medical",
      "security",
    ]);
    for (const domain of SAFETY_CRITICAL_DOMAINS) expect(PROMPT_DOMAINS).toContain(domain);
  });
});

// ─── Profile catalog consistency ─────────────────────────────────────────────────
describe("prompt enhancer profile catalog", () => {
  it("has exactly one entry per profile id with a matching id", () => {
    const ids = Object.keys(PROMPT_ENHANCEMENT_PROFILES) as PromptEnhancementProfileId[];
    expect(new Set(ids)).toEqual(new Set(PROMPT_ENHANCEMENT_PROFILE_IDS));
    for (const id of PROMPT_ENHANCEMENT_PROFILE_IDS) {
      expect(PROMPT_ENHANCEMENT_PROFILES[id].id).toBe(id);
    }
  });

  it("only references known output formats and non-negative clarification bounds", () => {
    for (const id of PROMPT_ENHANCEMENT_PROFILE_IDS) {
      const profile = PROMPT_ENHANCEMENT_PROFILES[id];
      for (const mode of profile.preferredOutputModes)
        expect(PROMPT_OUTPUT_FORMATS).toContain(mode);
      expect(profile.maxClarifications).toBeGreaterThanOrEqual(0);
    }
  });

  it("mandates grounding for the research and safety-critical profiles", () => {
    expect(PROMPT_ENHANCEMENT_PROFILES.research.groundingMandatory).toBe(true);
    expect(PROMPT_ENHANCEMENT_PROFILES["safety-critical"].groundingMandatory).toBe(true);
  });
});

// ─── Wire-shape stability ────────────────────────────────────────────────────────
describe("prompt enhancer wire-shape stability", () => {
  it("pins the schema version to a single literal", () => {
    expect(PROMPT_ENHANCER_SCHEMA_VERSION).toBe("1");
  });

  it("round-trips the profile catalog through JSON unchanged", () => {
    expect(JSON.parse(JSON.stringify(PROMPT_ENHANCEMENT_PROFILES))).toEqual(
      PROMPT_ENHANCEMENT_PROFILES,
    );
  });

  it("round-trips an enhanced prompt through JSON unchanged", () => {
    expect(JSON.parse(JSON.stringify(sampleEnhancedPrompt))).toEqual(sampleEnhancedPrompt);
  });
});

// ─── Core primitives ─────────────────────────────────────────────────────────────
describe("prompt enhancer core primitives", () => {
  it("rejects a non-NFKC id", () => {
    const result = validatePromptEnhancerIdString("Ａ", "PromptEnhancementRequestId");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("NFKC");
  });

  it("truncates an over-long draft to the scan bound", () => {
    const huge = "a".repeat(PROMPT_ANALYSIS_MAX_SCAN_CHARS + 500);
    expect(normalizePromptDraft(huge).length).toBe(PROMPT_ANALYSIS_MAX_SCAN_CHARS);
  });

  it("leaves a short draft unchanged", () => {
    expect(normalizePromptDraft("hello")).toBe("hello");
  });

  it("assertNeverTaskClass throws when reached at runtime", () => {
    expect(() => assertNeverTaskClass("not-a-class" as never)).toThrow(TypeError);
  });
});
