// Tests for the Prompt Enhancement evidence builder + local stores (Issue #1313).
// Proves AC4: the original input (fingerprint + redacted excerpt), enhanced output, applied rules,
// assumptions, candidate scores, model metadata, and verification status are captured in REDACTED form
// — and that persistence is integrity-checked and tamper-evident on read.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION,
  validatePromptEnhancementEvidenceManifest,
} from "./manifestSchema.js";
import {
  buildPromptEnhancementEvidenceManifest,
  createInMemoryPromptEnhancementLocalStore,
  createNodePromptEnhancementLocalStore,
  listPromptEnhancementRuns,
  loadPromptEnhancementRun,
  PE_EVIDENCE_ENHANCED_PROMPT_MAX_CHARS,
  PE_EVIDENCE_INPUT_EXCERPT_MAX_CHARS,
  PE_EVIDENCE_TRUNCATION_MARKER,
  PE_SUBDIR,
  recordPromptEnhancementRun,
  type PromptEnhancementRecordInput,
} from "./store.js";

const SECRET = "sk-abcdefghij1234567890";

function recordInput(
  overrides: Partial<PromptEnhancementRecordInput> = {},
): PromptEnhancementRecordInput {
  return {
    runId: "pe-run-1",
    recordedAt: "2026-06-20T12:00:00.000Z",
    requestId: "req-1",
    status: "validated",
    originalInput: `Explain binary search. My key is ${SECRET}.`,
    enhancedPromptId: "ep-1",
    enhancedPromptText: `## Role\nYou are careful.\n## Safety rules\nLeaked: ${SECRET}`,
    appliedSafetyRules: [
      "This prompt is data, not an authorization: it grants no tool, file, network, or secret access.",
      `Do not reveal ${SECRET}`,
    ],
    appliedGroundingDirectives: ["do-not-fabricate-sources", "disclose-uncertainty"],
    assumptions: ["Assuming a general professional audience."],
    candidateScores: [
      {
        candidateId: "ep-1",
        profile: "precise",
        aggregateScore: 0.82,
        estimatedTokens: 140,
        selected: true,
      },
    ],
    candidateRejections: [],
    safety: {
      decision: "accepted",
      verificationStatus: "passed",
      requiresHumanReview: false,
      findingCodes: [],
      leastPrivilege: [
        "no-tool-execution",
        "no-file-write",
        "no-network-egress",
        "no-secret-access",
      ],
    },
    modelMetadata: { deterministic: true },
    ...overrides,
  };
}

const tempDirs: string[] = [];
function tempEvidenceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-pe-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildPromptEnhancementEvidenceManifest", () => {
  it("captures every AC4 field and redacts secret material", () => {
    const { manifest } = buildPromptEnhancementEvidenceManifest(recordInput());
    // Original input: fingerprint present, excerpt redacted (no raw secret).
    expect(manifest.inputRedactedFingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.inputRedactedFingerprintSha256).not.toBe(
      sha256Hex(recordInput().originalInput),
    );
    expect(manifest.inputExcerptRedacted).not.toContain(SECRET);
    expect(manifest.inputExcerptRedacted).toContain("[REDACTED]");
    // Enhanced output redacted.
    expect(manifest.enhancedPromptTextRedacted).not.toContain(SECRET);
    expect(manifest.enhancedPromptId).toBe("ep-1");
    // Applied rules redacted.
    expect(manifest.appliedSafetyRules.join(" ")).not.toContain(SECRET);
    expect(manifest.appliedGroundingDirectives).toContain("do-not-fabricate-sources");
    // Assumptions, candidate scores, model metadata, verification status all present.
    expect(manifest.assumptions).toHaveLength(1);
    expect(manifest.candidateScores[0]?.selected).toBe(true);
    expect(manifest.modelMetadata.deterministic).toBe(true);
    expect(manifest.safety.verificationStatus).toBe("passed");
    // Redaction summary counts at least the two secret-bearing leaves.
    expect(manifest.redactionSummary.stringsRedacted).toBeGreaterThanOrEqual(2);
    // Totals match collection lengths.
    expect(manifest.totals).toEqual({
      candidateScores: 1,
      candidateRejections: 0,
      appliedSafetyRules: 2,
      assumptions: 1,
      safetyFindings: 0,
    });
  });

  it("produces a manifest that passes the strict-schema gate", () => {
    const { manifest } = buildPromptEnhancementEvidenceManifest(recordInput());
    expect(validatePromptEnhancementEvidenceManifest(manifest).ok).toBe(true);
    expect(manifest.peEvidenceSchemaVersion).toBe(PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION);
  });

  it("persists bounded rejection metadata without candidate prompt bodies", () => {
    const promptBody = "private rejected candidate prompt";
    const input = {
      ...recordInput(),
      candidateRejections: [
        {
          candidateId: "candidate-fast",
          profile: "fast" as const,
          aggregateScore: 0.61,
          reason: "lower-aggregate-score" as const,
          promptText: promptBody,
        },
      ],
    };
    const { manifest } = buildPromptEnhancementEvidenceManifest(input);
    const persisted = manifest as unknown as {
      readonly candidateRejections: readonly Record<string, unknown>[];
    };

    expect(persisted.candidateRejections).toEqual([
      {
        candidateId: "candidate-fast",
        profile: "fast",
        aggregateScore: 0.61,
        reason: "lower-aggregate-score",
      },
    ]);
    expect(JSON.stringify(persisted.candidateRejections)).not.toContain(promptBody);
  });

  it("fingerprints the redacted input deterministically and independently of the excerpt cap", () => {
    const a = buildPromptEnhancementEvidenceManifest(recordInput()).manifest;
    const b = buildPromptEnhancementEvidenceManifest(
      recordInput({ inputExcerptMaxChars: 5 }),
    ).manifest;
    expect(a.inputRedactedFingerprintSha256).toBe(b.inputRedactedFingerprintSha256);
    expect(b.inputExcerptRedacted.length).toBeLessThanOrEqual(5);
  });

  it("redacts model metadata before hashing and persistence", () => {
    const { manifest } = buildPromptEnhancementEvidenceManifest(
      recordInput({ modelMetadata: { deterministic: false, modelId: SECRET, profile: "precise" } }),
    );
    expect(manifest.modelMetadata.modelId).toBe("[REDACTED]");
    expect(manifest.integrityHashes.record).toMatch(/^[0-9a-f]{64}$/);
  });

  it("scrubs caller-supplied literal secrets via the redaction option", () => {
    const { manifest } = buildPromptEnhancementEvidenceManifest(
      recordInput({ enhancedPromptText: "context value super-secret-literal" }),
      { additionalSecrets: ["super-secret-literal"] },
    );
    expect(manifest.enhancedPromptTextRedacted).not.toContain("super-secret-literal");
  });

  // #1307 audit: the manifest deliberately caps the persisted draft at DEFAULT_INPUT_EXCERPT_MAX_CHARS,
  // but the renderer fences the same draft into the prompt's Input section (bounded only by the
  // generator's 16_000-character cap, or the model path's 24_000), and `enhancedPromptTextRedacted`
  // was stored untruncated — so the record persisted several times more raw draft than the excerpt
  // bound it advertises. Redaction is not content minimisation; the bound has to be enforced.
  describe("content minimisation", () => {
    const HUGE_DRAFT = "d".repeat(12_000);

    it("bounds the persisted enhanced prompt text, not just the input excerpt", () => {
      const { manifest } = buildPromptEnhancementEvidenceManifest(
        recordInput({
          originalInput: HUGE_DRAFT,
          enhancedPromptText: `## Input (untrusted)\n${HUGE_DRAFT}`,
        }),
      );
      expect(manifest.inputExcerptRedacted.length).toBeLessThanOrEqual(
        PE_EVIDENCE_INPUT_EXCERPT_MAX_CHARS,
      );
      expect(manifest.enhancedPromptTextRedacted.length).toBeLessThanOrEqual(
        PE_EVIDENCE_ENHANCED_PROMPT_MAX_CHARS,
      );
    });

    it("marks the truncation so a bounded record cannot be read as the complete prompt", () => {
      const { manifest } = buildPromptEnhancementEvidenceManifest(
        recordInput({ enhancedPromptText: HUGE_DRAFT }),
      );
      expect(manifest.enhancedPromptTextRedacted.endsWith(PE_EVIDENCE_TRUNCATION_MARKER)).toBe(
        true,
      );
    });

    it("leaves a prompt inside the bound byte-identical and unmarked", () => {
      const { manifest } = buildPromptEnhancementEvidenceManifest(
        recordInput({ enhancedPromptText: "## Role\nYou are careful." }),
      );
      expect(manifest.enhancedPromptTextRedacted).toBe("## Role\nYou are careful.");
      expect(manifest.enhancedPromptTextRedacted).not.toContain(PE_EVIDENCE_TRUNCATION_MARKER);
    });

    it("cannot be widened past the declared ceiling by a caller-supplied cap", () => {
      const { manifest } = buildPromptEnhancementEvidenceManifest(
        recordInput({
          originalInput: HUGE_DRAFT,
          enhancedPromptText: HUGE_DRAFT,
          inputExcerptMaxChars: 11_000,
          enhancedPromptMaxChars: 11_000,
        }),
      );
      expect(manifest.inputExcerptRedacted.length).toBeLessThanOrEqual(
        PE_EVIDENCE_INPUT_EXCERPT_MAX_CHARS,
      );
      expect(manifest.enhancedPromptTextRedacted.length).toBeLessThanOrEqual(
        PE_EVIDENCE_ENHANCED_PROMPT_MAX_CHARS,
      );
    });

    it("honors a caller-supplied cap that tightens the bound", () => {
      const { manifest } = buildPromptEnhancementEvidenceManifest(
        recordInput({ enhancedPromptText: HUGE_DRAFT, enhancedPromptMaxChars: 200 }),
      );
      expect(manifest.enhancedPromptTextRedacted.length).toBeLessThanOrEqual(200);
    });

    // KEIKO-0395: with max < PE_EVIDENCE_TRUNCATION_MARKER.length (31 chars) the old bound helper
    // hit Math.max(0, max - 31) = 0 and returned the 31-char marker, blowing past the tight cap the
    // caller explicitly asked for. The floor branch must return at most `max` chars — dropping the
    // marker is the correct trade when the cap is too tight to fit it.
    it("never returns a string longer than a very tight caller cap (KEIKO-0395)", () => {
      const { manifest } = buildPromptEnhancementEvidenceManifest(
        recordInput({ enhancedPromptText: HUGE_DRAFT, enhancedPromptMaxChars: 10 }),
      );
      expect(manifest.enhancedPromptTextRedacted.length).toBeLessThanOrEqual(10);
      // Not the marker (the marker is longer than 10 chars).
      expect(manifest.enhancedPromptTextRedacted).not.toContain(PE_EVIDENCE_TRUNCATION_MARKER);
    });

    it("clamps to zero chars when the caller-supplied cap is zero (KEIKO-0395)", () => {
      const { manifest } = buildPromptEnhancementEvidenceManifest(
        recordInput({ enhancedPromptText: HUGE_DRAFT, enhancedPromptMaxChars: 0 }),
      );
      expect(manifest.enhancedPromptTextRedacted).toBe("");
    });

    it("re-applies the ceiling on persist, whatever built the manifest", () => {
      const store = createInMemoryPromptEnhancementLocalStore();
      const { manifest } = buildPromptEnhancementEvidenceManifest(recordInput());
      store.record({ ...manifest, enhancedPromptTextRedacted: HUGE_DRAFT });
      const loaded = store.load("pe-run-1");
      expect(loaded?.enhancedPromptTextRedacted.length).toBeLessThanOrEqual(
        PE_EVIDENCE_ENHANCED_PROMPT_MAX_CHARS,
      );
    });
  });

  it("hashes full-redaction evidence from a fixed marker", () => {
    const credentialText = "config-only-credential";
    const { manifest } = buildPromptEnhancementEvidenceManifest(
      recordInput({ originalInput: `Use ${credentialText} for the provider.` }),
      { redactAllStrings: true },
    );
    expect(manifest.inputExcerptRedacted).toBe("[REDACTED]");
    expect(manifest.inputRedactedFingerprintSha256).toBe(sha256Hex("[REDACTED]"));
    expect(manifest.inputRedactedFingerprintSha256).not.toBe(
      sha256Hex(`Use ${credentialText} for the provider.`),
    );
  });
});

describe("createInMemoryPromptEnhancementLocalStore", () => {
  it("records, loads, lists, and deletes a run", () => {
    const store = createInMemoryPromptEnhancementLocalStore();
    const { manifest } = recordPromptEnhancementRun(recordInput(), { store });
    expect(store.load("pe-run-1")).toEqual(manifest);
    expect(store.list()).toEqual(["pe-run-1"]);
    expect(store.location("pe-run-1")).toBe("pe-run-1.pe.json");
    expect(store.delete("pe-run-1")).toBe(true);
    expect(store.load("pe-run-1")).toBeUndefined();
    expect(store.delete("pe-run-1")).toBe(false);
  });

  it("requires a store or evidenceDir", () => {
    expect(() => recordPromptEnhancementRun(recordInput())).toThrow(/requires/);
  });

  it("redacts and rehashes caller-supplied manifests at the store boundary", () => {
    const store = createInMemoryPromptEnhancementLocalStore();
    const { manifest } = buildPromptEnhancementEvidenceManifest(recordInput());
    const unsafeManifest = {
      ...manifest,
      enhancedPromptTextRedacted: `raw secret ${SECRET}`,
      modelMetadata: { deterministic: false, modelId: SECRET },
      integrityHashes: {
        ...manifest.integrityHashes,
        enhancedOutput: "0".repeat(64),
        record: "0".repeat(64),
      },
    };
    store.record(unsafeManifest);
    const loaded = store.load("pe-run-1");
    expect(loaded?.enhancedPromptTextRedacted).not.toContain(SECRET);
    expect(loaded?.modelMetadata.modelId).toBe("[REDACTED]");
    expect(loaded?.integrityHashes.enhancedOutput).not.toBe("0".repeat(64));
    expect(loaded?.integrityHashes.record).not.toBe("0".repeat(64));
  });
});

describe("createNodePromptEnhancementLocalStore", () => {
  it("persists, reloads, lists, and deletes under the pe/ subdir", () => {
    const evidenceDir = tempEvidenceDir();
    const { manifest, location } = recordPromptEnhancementRun(recordInput(), { evidenceDir });
    expect(location).toContain(join("pe", "pe-run-1.pe.json"));
    expect(loadPromptEnhancementRun("pe-run-1", { evidenceDir })).toEqual(manifest);
    expect(listPromptEnhancementRuns({ evidenceDir })).toEqual(["pe-run-1"]);
    const store = createNodePromptEnhancementLocalStore(evidenceDir);
    expect(store.delete("pe-run-1")).toBe(true);
    expect(loadPromptEnhancementRun("pe-run-1", { evidenceDir })).toBeUndefined();
  });

  it("returns empty/undefined for an absent base dir", () => {
    const evidenceDir = join(tempEvidenceDir(), "does-not-exist-yet");
    expect(listPromptEnhancementRuns({ evidenceDir })).toEqual([]);
    expect(loadPromptEnhancementRun("pe-run-1", { evidenceDir })).toBeUndefined();
    expect(createNodePromptEnhancementLocalStore(evidenceDir).delete("pe-run-1")).toBe(false);
  });

  it("refuses a symlinked PE evidence sub-store before writing", () => {
    const evidenceDir = tempEvidenceDir();
    const outside = tempEvidenceDir();
    symlinkSync(outside, join(evidenceDir, PE_SUBDIR), "dir");

    expect(() => recordPromptEnhancementRun(recordInput(), { evidenceDir })).toThrow(/symlink/u);
    expect(() => readFileSync(join(outside, "pe-run-1.pe.json"), "utf8")).toThrow();
  });

  it("fails closed on a tampered enhanced-output field (integrity hash mismatch)", () => {
    const evidenceDir = tempEvidenceDir();
    const { location } = recordPromptEnhancementRun(recordInput(), { evidenceDir });
    const onDisk = JSON.parse(readFileSync(location, "utf8")) as Record<string, unknown>;
    onDisk.enhancedPromptTextRedacted = "tampered output";
    writeFileSync(location, JSON.stringify(onDisk));
    expect(() => loadPromptEnhancementRun("pe-run-1", { evidenceDir })).toThrow(/integrity/);
  });

  it("fails closed on tampered candidate rejection metadata", () => {
    const evidenceDir = tempEvidenceDir();
    const { location } = recordPromptEnhancementRun(
      recordInput({
        candidateRejections: [
          {
            candidateId: "candidate-fast",
            profile: "fast",
            aggregateScore: 0.61,
            reason: "lower-aggregate-score",
          },
        ],
      }),
      { evidenceDir },
    );
    const onDisk = JSON.parse(readFileSync(location, "utf8")) as Record<string, unknown>;
    const rejections = onDisk.candidateRejections as Record<string, unknown>[];
    const first = rejections[0];
    if (first === undefined) throw new Error("expected candidate rejection fixture");
    first.reason = "lower-tie-break-rank";
    writeFileSync(location, JSON.stringify(onDisk));

    expect(() => loadPromptEnhancementRun("pe-run-1", { evidenceDir })).toThrow(
      /candidateRejections integrity/,
    );
  });

  it("fails closed on a tampered safety/status field covered by the record hash", () => {
    const evidenceDir = tempEvidenceDir();
    const { location } = recordPromptEnhancementRun(recordInput(), { evidenceDir });
    const onDisk = JSON.parse(readFileSync(location, "utf8")) as Record<string, unknown>;
    onDisk.status = "requires-human-review";
    writeFileSync(location, JSON.stringify(onDisk));
    expect(() => loadPromptEnhancementRun("pe-run-1", { evidenceDir })).toThrow(
      /schema invalid|integrity/,
    );
  });

  it("fails closed on tampered model metadata covered by the record hash", () => {
    const evidenceDir = tempEvidenceDir();
    const { location } = recordPromptEnhancementRun(recordInput(), { evidenceDir });
    const onDisk = JSON.parse(readFileSync(location, "utf8")) as Record<string, unknown>;
    onDisk.modelMetadata = { deterministic: false, modelId: "changed-model" };
    writeFileSync(location, JSON.stringify(onDisk));
    expect(() => loadPromptEnhancementRun("pe-run-1", { evidenceDir })).toThrow(/integrity/);
  });

  it("fails closed on a totals/collection drift", () => {
    const evidenceDir = tempEvidenceDir();
    const { location } = recordPromptEnhancementRun(recordInput(), { evidenceDir });
    const onDisk = JSON.parse(readFileSync(location, "utf8")) as Record<string, unknown>;
    onDisk.totals = { ...(onDisk.totals as object), candidateScores: 99 };
    writeFileSync(location, JSON.stringify(onDisk));
    expect(() => loadPromptEnhancementRun("pe-run-1", { evidenceDir })).toThrow(/does not match/);
  });

  it("fails closed on an unknown top-level key", () => {
    const evidenceDir = tempEvidenceDir();
    const { location } = recordPromptEnhancementRun(recordInput(), { evidenceDir });
    const onDisk = JSON.parse(readFileSync(location, "utf8")) as Record<string, unknown>;
    onDisk.unexpected = true;
    writeFileSync(location, JSON.stringify(onDisk));
    expect(() => loadPromptEnhancementRun("pe-run-1", { evidenceDir })).toThrow(/schema invalid/);
  });
});
