import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import {
  QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR,
  QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR,
  QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR,
  QI_VALIDATION_WORKFLOW_DESCRIPTOR,
  QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS,
  findQualityIntelligenceWorkflowDescriptor,
} from "../descriptors.js";

describe("QI workflow descriptors", () => {
  it("exposes exactly 4 descriptors", () => {
    expect(QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS).toHaveLength(4);
  });

  it("descriptor IDs are unique and stable", () => {
    const ids = QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS.map((d) => d.workflowId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR.workflowId);
    expect(ids).toContain(QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR.workflowId);
    expect(ids).toContain(QI_VALIDATION_WORKFLOW_DESCRIPTOR.workflowId);
    expect(ids).toContain(QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR.workflowId);
  });

  it("each descriptor has a non-empty stage list", () => {
    for (const descriptor of QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS) {
      expect(descriptor.stageNames.length).toBeGreaterThan(0);
    }
  });

  it("descriptors are frozen at the top level", () => {
    expect(Object.isFrozen(QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS)).toBe(true);
  });

  it("findQualityIntelligenceWorkflowDescriptor returns the right descriptor by id", () => {
    const found = findQualityIntelligenceWorkflowDescriptor(
      QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR.workflowId,
    );
    expect(found).toBe(QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR);
  });

  it("findQualityIntelligenceWorkflowDescriptor throws for unknown id", () => {
    // @ts-expect-error — intentionally passing an invalid id
    expect(() => findQualityIntelligenceWorkflowDescriptor("qi:nonexistent")).toThrow();
  });

  // KEIKO-0274 / Codex thread 3788600304: stageNames used to be a bare `readonly string[]`, so a
  // descriptor stage that drifted from QualityIntelligenceStageName had no compile-time link to
  // catch it, and a fixture asserting the union's members by a hand-copied literal list could not
  // detect it either. `stageNames` is now typed against QualityIntelligence.QualityIntelligenceStageName
  // (a drifted or misspelled stage name is a compile error), and this test additionally proves the
  // runtime invariant by enumerating the actual descriptors against the actual canonical constant —
  // neither side is a copy of the other.
  it("every descriptor's stageNames are members of QUALITY_INTELLIGENCE_STAGE_NAMES", () => {
    const canonical = new Set<string>(QualityIntelligence.QUALITY_INTELLIGENCE_STAGE_NAMES);
    for (const descriptor of QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS) {
      for (const stageName of descriptor.stageNames) {
        expect(
          canonical.has(stageName),
          `${descriptor.workflowId} declares unknown stage ${stageName}`,
        ).toBe(true);
      }
    }
  });

  // The reverse direction: every canonical stage name is actually used by at least one descriptor,
  // so the union in contracts cannot silently grow a name no workflow ever declares.
  it("every QUALITY_INTELLIGENCE_STAGE_NAMES member is used by at least one descriptor", () => {
    const used = new Set<string>(
      QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS.flatMap((descriptor) => descriptor.stageNames),
    );
    for (const stageName of QualityIntelligence.QUALITY_INTELLIGENCE_STAGE_NAMES) {
      expect(used.has(stageName), `${stageName} is declared but no descriptor uses it`).toBe(true);
    }
  });
});
